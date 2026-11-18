"""Fixed proxy workspace adapter. Requests/content arrive on stdin, never argv.
System services and local Docker bind-mounted file configurations only.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import select
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

LIMIT = 2 * 1024 * 1024
ROOTS = {'caddy': '/etc/caddy', 'nginx': '/etc/nginx', 'traefik': '/etc/traefik'}
MAIN = {'caddy': 'Caddyfile', 'nginx': 'nginx.conf', 'traefik': 'traefik.yml'}


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()).hexdigest()


def run(args, seconds=20, allow=False):
    if args[0] == 'docker':
        args = ['docker', '--host', 'unix:///var/run/docker.sock', *args[1:]]
    # Private temporary output bounds memory, even for a noisy external command.
    with tempfile.TemporaryFile() as out:
        p = subprocess.Popen(args, stdout=out, stderr=subprocess.STDOUT, start_new_session=True,
                             env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LC_ALL': 'C', 'LANG': 'C'})
        deadline = time.monotonic() + seconds
        while p.poll() is None:
            if time.monotonic() > deadline or out.tell() > LIMIT:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
                raise ValueError('Proxy command timed out or exceeded its output limit')
            time.sleep(.04)
        out.seek(0)
        text = out.read(LIMIT + 1).decode(errors='replace')
        if len(text.encode()) > LIMIT:
            raise ValueError('Proxy command output exceeds its limit')
        if p.returncode and not allow:
            # Configuration validators can echo secrets. Keep details transient in UI only.
            raise ValueError(text[-16000:] or 'Proxy command failed')
        return text


def clean_path(value):
    if not isinstance(value, str) or not value.startswith('/') or len(value) > 1024 or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid configuration path')
    p = pathlib.Path(value)
    if '..' in p.parts or any(part.startswith('.vps-pilot') for part in p.parts):
        raise ValueError('Invalid configuration path')
    return p


def no_links(p, missing=False):
    p = clean_path(str(p))
    for part in [*reversed(p.parents), p]:
        try:
            m = part.lstat()
        except FileNotFoundError:
            if missing and part == p:
                continue
            raise
        if stat.S_ISLNK(m.st_mode):
            raise ValueError('Symlink configuration paths require manual review')
    return p


def config_name(manager, name, parent=""):
    lower = name.lower()
    if any(word in lower for word in ('acme', 'private', 'secret', 'credential')) or name.startswith('.'):
        return False
    if manager == 'caddy':
        return name == 'Caddyfile' or lower.endswith(('.caddy', '.caddyfile', '.conf', '.json'))
    if manager == 'nginx':
        return lower.endswith(('.conf', '.types')) or name in ('fastcgi_params', 'uwsgi_params', 'scgi_params', 'proxy_params', 'default') or parent in ('sites-available', 'sites-enabled')
    return lower.endswith(('.yaml', '.yml', '.toml'))


def argv_config(manager, args):
    default = ROOTS[manager] + '/' + MAIN[manager]
    config = default
    for i, arg in enumerate(args):
        if arg in ('--config', '--configFile', '-c') and i + 1 < len(args):
            config = args[i + 1]
        if arg.lower().startswith('--configfile=') or arg.startswith('--config='):
            config = arg.split('=', 1)[1]
    if manager == 'traefik' and config == default:
        for suffix in ('yml', 'yaml', 'toml'):
            candidate = ROOTS[manager] + '/traefik.' + suffix
            if os.path.isfile(candidate):
                config = candidate
                break
    clean_path(config)
    return config


def service(manager):
    fields = 'Id,LoadState,ActiveState,MainPID,FragmentPath,DropInPaths,Environment,EnvironmentFiles,NeedDaemonReload,Job,ExecStartPre,ExecStartPost,ExecStopPost,OnFailure,OnSuccess,RequiredBy,BoundBy,ConsistsOf,PropagatesStopTo,TriggeredBy,User,ExecStop,ExecStart'
    text = run(['systemctl', 'show', '--no-pager', '--property=' + fields, manager + '.service'], allow=True)
    props = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    if props.get('LoadState') not in ('loaded', 'masked'):
        return None
    result = dict(id='system:' + manager, manager=manager, kind='system', name=manager + '.service',
                  status=props.get('ActiveState', 'unknown'), config=ROOTS[manager] + '/' + MAIN[manager],
                  roots=[{'host': ROOTS[manager], 'container': ROOTS[manager], 'directory': True}], editable=False, actions=False)
    try:
        pid = int(props.get('MainPID', '0'))
        if pid > 1:
            exe = os.readlink('/proc/%s/exe' % pid)
            args = pathlib.Path('/proc/%s/cmdline' % pid).read_bytes().decode().strip('\0').split('\0')
        else:
            start = props.get('ExecStart', '')
            executable = re.search(r'path=([^;]+) ;', start)
            invocation = re.search(r'argv\[\]=(.*?) ; ignore_errors=', start)
            if not executable or not invocation:
                raise ValueError('Cannot reconstruct the stopped service startup command')
            exe = executable.group(1).strip()
            args = shlex.split(invocation.group(1))
        if pathlib.Path(exe).name != manager or not exe.startswith(('/usr/bin/', '/usr/sbin/', '/usr/local/bin/', '/usr/local/sbin/')):
            raise ValueError('The service executable needs manual review')
        config = argv_config(manager, args)
        if not (config == ROOTS[manager] or config.startswith(ROOTS[manager] + '/')):
            raise ValueError('Configuration outside the standard proxy directory needs manual review')
        blocked = any(props.get(key) for key in ('DropInPaths', 'Environment', 'EnvironmentFiles', 'Job', 'ExecStartPost', 'ExecStopPost', 'OnFailure', 'OnSuccess', 'RequiredBy', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo', 'TriggeredBy'))
        if props.get('ExecStartPre'):
            pre = props['ExecStartPre']
            if manager != 'nginx' or not re.search(r'argv\[\]=/usr/sbin/nginx -t(?: | ;)', pre) or '/bin/sh' in pre:
                blocked = True
        if props.get('ExecStop'):
            stop = props['ExecStop']
            if manager != 'nginx' or not any(v in stop for v in ('argv[]=/sbin/start-stop-daemon --quiet --stop', 'argv[]=/usr/sbin/nginx -s quit')) or '/bin/sh' in stop:
                blocked = True
        binary_meta = pathlib.Path(exe).stat()
        fragment = pathlib.Path(props.get('FragmentPath', '')).resolve()
        if binary_meta.st_uid != 0 or binary_meta.st_mode & 0o022 or not str(fragment).startswith(('/etc/systemd/system/', '/usr/lib/systemd/system/')):
            blocked = True
        if fragment.stat().st_uid != 0 or fragment.stat().st_mode & 0o022:
            blocked = True
        if props.get('NeedDaemonReload') != 'no' or props.get('Id') != manager + '.service':
            blocked = True
        if manager == 'caddy' and ('--resume' in args or '--watch' in args):
            blocked = True
        if manager == 'nginx' and re.search(r'(?:^|\s)-(?:p|c)(?:\s|/)', ' '.join(args)):
            # nginx rewrites its process title; custom runtime prefixes cannot be reconstructed reliably.
            blocked = True
        result.update(config=config, binary=exe, args=args, pid=pid, user=props.get('User', ''), editable=not blocked, actions=not blocked)
        if blocked:
            result['message'] = 'Custom service settings require manual review; configuration viewing remains available'
        result['_identity'] = props
    except (OSError, ValueError) as e:
        result['message'] = str(e) if isinstance(e, ValueError) else 'Permission to inspect the running service is required'
    return result


def docker_instances():
    engine = json.loads(run(['docker', 'info', '--format', '{"id":{{json .ID}},"name":{{json .Name}}}']))
    if engine.get('name') != os.uname().nodename:
        raise ValueError('Docker engine is not on this SSH host; remote daemon configuration edits are disabled')
    ids = run(['docker', 'ps', '-aq', '--no-trunc']).split()
    if len(ids) > 256:
        raise ValueError('Docker inventory exceeds 256 containers')
    if not ids:
        return []
    # Inspect locally; only the projection below ever crosses the SSH channel.
    items = json.loads(run(['docker', 'inspect', *ids]))
    results = []
    for c in items:
        config = c.get('Config') or {}
        args = [c.get('Path', ''), *(c.get('Args') or [])]
        image = (config.get('Image') or '').split('/')[-1].split(':')[0].split('@')[0]
        binary = pathlib.PurePosixPath(args[0]).name
        if binary.endswith('entrypoint.sh') and len(args) > 1:
            binary = pathlib.PurePosixPath(args[1]).name
        manager = binary if binary in ROOTS else image if image in ROOTS else None
        if not manager:
            continue
        container = c['Id']
        if not re.fullmatch('[0-9a-f]{64}', container):
            raise ValueError('Invalid Docker container identity')
        labels = config.get('Labels') or {}
        mounts = c.get('Mounts') or []
        roots = []
        for m in mounts:
            dest = m.get('Destination', '')
            if m.get('Type') == 'bind' and (dest == ROOTS[manager] or dest.startswith(ROOTS[manager] + '/')):
                host = m.get('Source', '')
                if host.startswith('/'):
                    roots.append(dict(host=host, container=dest, directory=os.path.isdir(host)))
        main = argv_config(manager, args)
        dynamic = [a.split('=', 1)[1] for a in args if a.lower().startswith(('--providers.file.directory=', '--providers.file.filename='))]
        for dest in dynamic:
            for m in mounts:
                if m.get('Type') == 'bind' and m.get('Destination') == dest and not any(r['container'] == dest for r in roots):
                    roots.append(dict(host=m['Source'], container=dest, directory=os.path.isdir(m['Source'])))
        state = c.get('State') or {}
        guarded = c.get('HostConfig') or {}
        editable = any(r['directory'] for r in roots) and not guarded.get('Privileged') and not guarded.get('PidMode') == 'host'
        item = dict(id='docker:' + container, manager=manager, kind='docker', name=c.get('Name', '').lstrip('/'),
                    container=container, status=state.get('Status', 'unknown'), config=main, roots=roots,
                    editable=editable, actions=state.get('Running') is True and not guarded.get('Privileged'),
                    composeProject=labels.get('com.docker.compose.project'), composeService=labels.get('com.docker.compose.service'),
                    labelRoutes=any(k.startswith('traefik.http.') or k.startswith('traefik.tcp.') for k in labels),
                    binary=manager, args=args)
        if not roots:
            item['message'] = 'No editable host bind-mounted configuration. Configuration may belong to the image, a volume, or Docker labels.'
        elif any(not r['directory'] for r in roots):
            item['message'] = 'Single-file mounts can be read. Use a directory mount for atomic configuration editing.'
        if manager == 'caddy' and '--resume' in args:
            item.update(editable=False, actions=False, message='Caddy API/resume mode requires its owning deployment; file-based changes are disabled.')
        item['startupExternal'] = manager == 'traefik' and not any(a.lower().startswith('--configfile') for a in args) and (len(args) > 1 or any(v.startswith('TRAEFIK_') for v in config.get('Env') or []))
        if item['startupExternal']:
            item['message'] = 'Traefik startup settings belong to container arguments/environment. Mounted dynamic files remain editable; update startup settings in the owning deployment.'
        item['_identity'] = {'engine': engine.get('id'), 'id': container, 'image': c.get('Image'), 'started': state.get('StartedAt'), 'mounts': mounts,
                             'args': args, 'labels': labels, 'envHash': digest(config.get('Env') or [])}
        results.append(item)
    return results


def inventory():
    instances, warnings = [], []
    for manager in ROOTS:
        try:
            item = service(manager)
            if item:
                instances.append(item)
        except (OSError, ValueError, subprocess.SubprocessError):
            warnings.append(manager.title() + ': system service inspection unavailable')
    try:
        instances += docker_instances()
    except (OSError, ValueError, subprocess.SubprocessError):
        warnings.append('Docker inspection unavailable; check Docker access')
    for item in instances:
        item['identity'] = digest(item.get('_identity', item))
        item.pop('_identity', None)
    return {'instances': instances, 'warnings': warnings}


def select_instance(request):
    instance = next((v for v in inventory()['instances'] if v['id'] == request.get('instanceId')), None)
    if not instance or instance['identity'] != request.get('identity'):
        raise ValueError('Proxy identity changed. Detect again before continuing.')
    return instance


def allowed_host(p):
    value = str(clean_path(str(p)))
    forbidden = ('/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker', '/var/lib/containerd', '/var/lib/vps-pilot')
    if any(value == root or value.startswith(root + '/') for root in forbidden) or any(part in ('.ssh', '.gnupg') for part in pathlib.Path(value).parts):
        raise ValueError('Protected configuration source')
    return no_links(value)


def check_root(instance, value):
    p = clean_path(value)
    if instance['kind'] == 'docker':
        forbidden = ('/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var/lib', '/var/log')
        if str(p) in ('/', '/etc', '/var', '/home', '/root', '/tmp') or any(str(p) == v or str(p).startswith(v + '/') for v in forbidden):
            raise ValueError('Broad or protected Docker host mounts are not editable configuration roots')
        if str(p).startswith('/etc/') and not (str(p) == ROOTS[instance['manager']] or str(p).startswith(ROOTS[instance['manager']] + '/')):
            raise ValueError('Protected system configuration mount')


def files(instance):
    result, total = [], 0
    seen = set()
    directory_count = 0
    for root in instance['roots']:
        check_root(instance, root['host'])
        base = allowed_host(root['host'])
        paths = [base]
        if root['directory']:
            paths = []
            for directory, dirs, names in os.walk(base, followlinks=False):
                directory_count += 1
                if directory_count > 128:
                    raise ValueError('Configuration exceeds 128 directories')
                dirs[:] = [d for d in dirs if not d.startswith('.') and not pathlib.Path(directory, d).is_symlink()]
                if len(pathlib.Path(directory).relative_to(base).parts) >= 4:
                    dirs[:] = []
                for name in sorted(names):
                    if config_name(instance['manager'], name, pathlib.Path(directory).name):
                        paths.append(pathlib.Path(directory, name))
                if len(paths) > 128:
                    raise ValueError('Configuration exceeds 128 files')
        for p in sorted(paths):
            if p.is_symlink():
                # Standard nginx sites-enabled links remain visible, but target edits use sites-available.
                result.append(dict(path=str(p), target=str(p.resolve()), content='', revision='symlink', editable=False))
                continue
            p = allowed_host(p)
            if str(p) in seen or not config_name(instance['manager'], p.name, p.parent.name):
                continue
            seen.add(str(p))
            data, m = read_regular(p)
            total += len(data)
            if total > LIMIT:
                raise ValueError('Configuration exceeds 2 MiB')
            if b'\0' in data:
                raise ValueError('Binary configuration is not supported')
            container_path = str(pathlib.PurePosixPath(root['container']) / p.relative_to(base)) if root['directory'] else root['container']
            external_startup = instance.get('startupExternal') and container_path == instance['config']
            result.append(dict(path=str(p), content=data.decode('utf-8'), revision=digest([digest(data),m.st_mode,m.st_uid,m.st_gid,m.st_ino,m.st_mtime_ns]),
                               editable=instance['editable'] and root['directory'] and not external_startup, mode=stat.S_IMODE(m.st_mode)))
    if len(result) > 128:
        raise ValueError('Configuration exceeds 128 files')
    return result


def tree_revision(items):
    return digest([{k: f.get(k) for k in ('path', 'revision', 'target')} for f in items])


def target(instance, path):
    p = clean_path(path)
    if not config_name(instance['manager'], p.name, p.parent.name):
        raise ValueError('Choose a proxy configuration filename')
    for root in instance['roots']:
        check_root(instance, root['host'])
        base = clean_path(root['host'])
        if root['directory'] and p != base and base in p.parents:
            allowed_host(p.parent)
            no_links(p, missing=True)
            container_path = str(pathlib.PurePosixPath(root['container']) / p.relative_to(base))
            if instance.get('startupExternal') and container_path == instance['config']:
                raise ValueError('Startup configuration belongs to container arguments/environment')
            return p, root
    raise ValueError('Choose a file inside a detected configuration directory mount')


def service_command(instance, args, seconds=30):
    if instance['kind'] == 'docker':
        return run(['docker', 'exec', instance['container'], *args], seconds)
    return run(args, seconds)


def validation_args(instance):
    if instance['manager'] == 'nginx':
        return [instance['binary'], '-t', '-c', instance['config']]
    args = [instance['binary'], 'validate', '--config', instance['config']]
    if '--adapter' in instance['args']:
        i = instance['args'].index('--adapter')
        if i + 1 >= len(instance['args']):
            raise ValueError('Missing configuration adapter')
        args += ['--adapter', instance['args'][i + 1]]
    elif not instance['config'].endswith('.json'):
        args += ['--adapter', 'caddyfile']
    return args


def validate(instance):
    if instance['manager'] == 'traefik':
        return 'Traefik validates configuration on startup. Restart verifies process state, not route health.'
    args = validation_args(instance)
    if instance['kind'] == 'system' and instance['manager'] == 'caddy' and instance.get('user'):
        args = ['runuser', '-u', instance['user'], '--', *args]
    service_command(instance, args)
    return 'Configuration validation passed'


def lifecycle(instance, operation):
    if not instance['actions']:
        raise ValueError('This proxy deployment requires manual lifecycle review')
    manager = instance['manager']
    if manager == 'traefik' and operation == 'reload':
        raise ValueError('Traefik watches dynamic files automatically. Startup configuration requires Restart.')
    if operation == 'reload':
        if instance['kind'] == 'system' and instance['status'] != 'active':
            raise ValueError('The service is not active. Use Restart to start it.')
        validate(instance)
        select_instance({'instanceId': instance['id'], 'identity': instance['identity']})
        args = [instance['binary'], 'reload', '--config', instance['config']] if manager == 'caddy' else [instance['binary'], '-s', 'reload', '-c', instance['config']]
        service_command(instance, args)
    elif operation == 'restart':
        if manager != 'traefik':
            validate(instance)
        select_instance({'instanceId': instance['id'], 'identity': instance['identity']})
        if instance['kind'] == 'docker':
            run(['docker', 'restart', '--time', '20', instance['container']], 45)
        else:
            run(['systemctl', 'restart', instance['name']], 45)
    else:
        raise ValueError('Unsupported lifecycle operation')
    time.sleep(.4)
    if instance['kind'] == 'docker':
        status = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', instance['container']]))
        if not status.get('Running') or status.get('Restarting'):
            raise ValueError('Container is not running normally. Inspect Logs before retrying.')
    elif run(['systemctl', 'is-active', instance['name']]).strip() != 'active':
        raise ValueError('Service is not active. Inspect Logs before retrying.')
    return {'message': 'Proxy ' + ('reloaded' if operation == 'reload' else 'restarted') + '. Process state verified; upstream health is not checked.'}


def backup_root(instance):
    base = pathlib.Path('/var/lib/vps-pilot-proxy')
    if not base.exists():
        base.mkdir(mode=0o700)
    no_links(base)
    m = base.stat()
    if m.st_uid != 0 or m.st_mode & 0o077:
        raise ValueError('Unsafe proxy backup directory')
    folder = base / digest(instance['id'])
    folder.mkdir(mode=0o700, exist_ok=True)
    no_links(folder)
    return folder


def parent_fd(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_regular(path):
    directory = parent_fd(path)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'rb') as source:
            meta = os.fstat(source.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_size > 262144:
                raise ValueError('Configuration must be regular UTF-8 files below 256 KiB')
            data = source.read(262145)
            if len(data) > 262144:
                raise ValueError('Configuration exceeds 256 KiB')
            return data, meta
    finally:
        os.close(directory)


def write_atomic(path, data, mode, uid, gid):
    directory = parent_fd(path)
    name = '.vps-pilot-proxy-' + os.urandom(16).hex()
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        current = path.parent.stat()
        opened = os.fstat(directory)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('Configuration directory changed during save')
        os.replace(name, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name, dir_fd=directory)
        os.close(directory)


def stage_validate(instance, path, data):
    # Validate a private mount overlay: running processes never see an invalid candidate.
    # A new file uses a private copy of its parent so no placeholder is created in the live tree.
    if instance['manager'] == 'traefik':
        return
    with tempfile.TemporaryDirectory(prefix='vps-pilot-proxy-') as temporary:
        os.chmod(temporary, 0o755)
        overlay = pathlib.Path(temporary) / 'overlay'
        total = count = 0
        for folder, dirs, names in os.walk(path.parent, followlinks=False):
            if len(pathlib.Path(folder).relative_to(path.parent).parts) > 4:
                raise ValueError('Configuration staging exceeds its directory depth limit')
            count += len(dirs) + len(names)
            for name in names:
                p = pathlib.Path(folder, name)
                if p.is_symlink():
                    continue
                m = p.stat()
                if not stat.S_ISREG(m.st_mode):
                    raise ValueError('Non-regular files cannot be staged')
                total += m.st_size
            if count > 256 or total > LIMIT:
                raise ValueError('Configuration staging exceeds 256 entries or 2 MiB')
        shutil.copytree(path.parent, overlay, symlinks=True)
        (overlay / path.name).write_bytes(data)
        os.chmod(overlay / path.name, 0o644)
        if instance['kind'] == 'docker':
            # A separate validator container shares only the running container's mounts,
            # with the candidate directory overlaid. It has no network or Docker socket.
            root = next(r for r in instance['roots'] if pathlib.Path(r['host']) in path.parents and r['directory'])
            dest = str(pathlib.PurePosixPath(root['container']) / path.parent.relative_to(root['host']))
            meta = json.loads(run(['docker', 'inspect', instance['container']]))[0]
            mounts = []
            for mount in meta.get('Mounts', []):
                destination = mount.get('Destination', '')
                if destination in ('/var/run/docker.sock', '/run/docker.sock'):
                    continue
                if ',' in destination or ',' in mount.get('Source', ''):
                    raise ValueError('Mount names containing commas are unsupported for validation')
                if mount['Type'] == 'bind':
                    mounts += ['--mount', 'type=bind,src=' + mount['Source'] + ',dst=' + destination + ',readonly']
                elif mount['Type'] == 'volume':
                    mounts += ['--mount', 'type=volume,src=' + mount['Name'] + ',dst=' + destination + ',readonly']
            if ',' in str(overlay) or ',' in dest:
                raise ValueError('Unsupported configuration mount path')
            mounts += ['--mount', 'type=bind,src=' + str(overlay) + ',dst=' + dest + ',readonly']
            # Overlay replaces an existing mount when it targets that same directory.
            pairs = [mounts[i:i+2] for i in range(0, len(mounts), 2)]
            seen, filtered = set(), []
            for pair in reversed(pairs):
                destination = pair[1].split(',dst=', 1)[1].split(',', 1)[0]
                if destination not in seen:
                    filtered = pair + filtered
                    seen.add(destination)
            args = validation_args(instance)
            name = 'vps-pilot-proxy-validate-' + os.urandom(12).hex()
            try:
                run(['docker', 'run', '--rm', '--name', name, '--label', 'vps-pilot.proxy-validation=true', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--network', 'none', '--read-only', '--tmpfs', '/run:rw,noexec,nosuid,size=2m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=2m', '--tmpfs', '/var/log/nginx:rw,noexec,nosuid,size=2m', '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,size=2m', '--tmpfs', '/var/lib/nginx:rw,noexec,nosuid,size=2m', '--cap-drop', 'ALL', *(['--cap-add', 'CHOWN'] if instance['manager'] == 'nginx' else []), '--security-opt', 'no-new-privileges', '--entrypoint', args[0], *filtered, meta['Image'], *args[1:]], 30)
            finally:
                with contextlib.suppress(Exception):
                    owned = run(['docker', 'inspect', '--format', '{{ index .Config.Labels "vps-pilot.proxy-validation" }}', name], allow=True).strip()
                    if owned == 'true':
                        run(['docker', 'rm', '-f', name], 10)
        else:
            args = validation_args(instance)
            # Fixed worker child unshares before bind mounting; no command interpolates config text.
            child = r"""import os,re,stat,subprocess,sys

def call(args):
    subprocess.run(args,check=True)

def decode(path):
    return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),path)

mounts=[]
with open('/proc/self/mountinfo') as source:
    for line in source:
        fields=line.split()
        if 'rw' in fields[5].split(','):
            mounts.append(decode(fields[4]))
for target in sorted(set(mounts),key=len,reverse=True):
    call(['mount','--bind',target,target])
    call(['mount','-o','remount,bind,ro',target])
call(['mount','--bind',sys.argv[1],sys.argv[2]])
call(['mount','-o','remount,bind,ro',sys.argv[2]])
for target in ['/run','/tmp','/dev']:
    call(['mount','-t','tmpfs','-o','size=2m,nosuid,noexec,mode=1777','tmpfs',target])
for target in ['/var/log/nginx','/var/cache/nginx','/var/lib/nginx']:
    if os.path.isdir(target):
        call(['mount','-t','tmpfs','-o','size=2m,nosuid,noexec','tmpfs',target])
for name,minor in [('null',3),('zero',5),('random',8),('urandom',9)]:
    os.mknod('/dev/'+name,stat.S_IFCHR|0o666,os.makedev(1,minor))
for name,fd in [('stdin',0),('stdout',1),('stderr',2)]:
    os.symlink('/proc/self/fd/'+str(fd),'/dev/'+name)
args=sys.argv[3:]
if args[0]!='runuser':
    args=['setpriv','--bounding-set=-all,+chown','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--',*args]
else:
    args=['setpriv','--no-new-privs','--',*args]
call(args)
"""
            if instance['manager'] == 'caddy' and instance.get('user'):
                args = ['runuser', '-u', instance['user'], '--', *args]
            run(['unshare', '--mount', '--pid', '--fork', '--mount-proc', '--propagation', 'private', '--', '/usr/bin/python3', '-I', '-S', '-c', child, str(overlay), str(path.parent), *args], 30)


def save(instance, request):
    if not instance['editable']:
        raise ValueError('This configuration source is not editable')
    path, root = target(instance, request.get('path'))
    items = files(instance)
    if tree_revision(items) != request.get('treeRevision'):
        raise ValueError('Configuration changed outside VPS Pilot. Reopen configurations before saving.')
    existing = next((f for f in items if f['path'] == str(path)), None)
    if (existing['revision'] if existing else 'missing') != request.get('revision'):
        raise ValueError('Configuration file changed. Reopen before saving.')
    content = request.get('content')
    if not isinstance(content, str) or '\0' in content or len(content.encode()) > 262144:
        raise ValueError('Configuration must be UTF-8 text below 256 KiB')
    if instance['manager'] == 'traefik' and request.get('acknowledgeTraefik') is not True:
        raise ValueError('Acknowledge that Traefik has no offline configuration test before applying')
    stage_validate(instance, path, content.encode())
    # Validation can take time. Recheck source and content immediately before replacement.
    select_instance(request)
    if tree_revision(files(instance)) != request['treeRevision']:
        raise ValueError('Configuration changed during validation. Nothing was saved.')
    old, meta = read_regular(path) if existing else (None, path.parent.stat())
    if existing and old != existing['content'].encode():
        raise ValueError('Configuration changed immediately before save. Nothing was written.')
    mode = stat.S_IMODE(meta.st_mode) if existing else 0o644
    backup = backup_root(instance)
    record_id = str(time.time_ns())
    record = {'path': str(path), 'previous': old.decode() if old is not None else None, 'saved': digest(content.encode()), 'mode': mode, 'uid':meta.st_uid,'gid':meta.st_gid}
    fd = os.open(backup / (record_id + '.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(record, out)
        out.flush()
        os.fsync(out.fileno())
    write_atomic(path, content.encode(), mode, meta.st_uid, meta.st_gid)
    try:
        # Reload for Caddy/nginx, restart for Traefik (dynamic watchers may apply at replacement).
        result = lifecycle(instance, 'restart' if instance['manager'] == 'traefik' else 'reload')
    except (ValueError, OSError, subprocess.SubprocessError) as e:
        # Restore only our exact replacement; never overwrite a concurrent external edit.
        if path.is_file() and not path.is_symlink() and digest(read_regular(path)[0]) == record['saved']:
            if old is None:
                path.unlink()
            else:
                write_atomic(path, old, mode, meta.st_uid, meta.st_gid)
            raise ValueError('Apply failed. Previous file restored; runtime state must be checked in Logs. ' + str(e)[-8000:])
        raise ValueError('Apply failed and configuration changed externally. Backup retained; inspect before restoring.')
    fresh = next((v for v in inventory()['instances'] if v['id'] == instance['id']), None)
    if not fresh:
        raise ValueError('Save completed but proxy identity cannot be refreshed. Detect again; backup retained.')
    current_files = files(fresh)
    return {**result, 'instance': fresh, 'files': current_files, 'treeRevision': tree_revision(current_files), 'backupId': record_id, 'message': result['message'] + ' Backup saved.'}


def main(request):
    operation = request.get('operation')
    if operation == 'inventory':
        return inventory()
    instance = select_instance(request)
    if operation == 'open':
        items = files(instance)
        return {'files': items, 'treeRevision': tree_revision(items), 'instance': instance}
    if operation == 'logs':
        text = run(['docker', 'logs', '--tail', '150', instance['container']], allow=True) if instance['kind'] == 'docker' else run(['journalctl', '--no-pager', '-n', '150', '-u', instance['name']], allow=True)
        return {'logs': text[-64000:]}
    if operation == 'validate':
        return {'message': validate(instance)}
    if operation not in ('save', 'reload', 'restart', 'restore'):
        raise ValueError('Unsupported proxy operation')
    if os.geteuid() != 0:
        raise ValueError('Administrator approval is required')
    fd = os.open('/var/lib/vps-pilot-proxy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        m = os.fstat(lock.fileno())
        if not stat.S_ISREG(m.st_mode) or m.st_uid != 0 or m.st_mode & 0o077 or m.st_nlink != 1:
            raise ValueError('Unsafe proxy operation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        instance = select_instance(request)
        if operation in ('reload', 'restart'):
            return lifecycle(instance, operation)
        if operation == 'restore':
            ident = request.get('backupId', '')
            if not re.fullmatch(r'[0-9]{1,25}', ident):
                raise ValueError('Invalid backup identity')
            record = json.loads((backup_root(instance) / (ident + '.json')).read_text())
            if record['path'] != request.get('path'):
                raise ValueError('Backup path does not match the reviewed target')
            path, _ = target(instance, record['path'])
            if path.is_symlink() or not path.is_file() or digest(read_regular(path)[0]) != record['saved']:
                raise ValueError('Configuration changed after saving. Reopen and review before restoring.')
            if record['previous'] is None:
                path.unlink()
            else:
                write_atomic(path, record['previous'].encode(), record['mode'], record['uid'], record['gid'])
            return {'message': 'Previous file restored. Validate and reload/restart to apply it.'}
        return save(instance, request)
