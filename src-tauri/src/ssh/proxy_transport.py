# WORKER is fixed native source, supplied by Rust; private request only on stdin.
import json, os, select, signal, subprocess, sys, time

def main():
    raw = sys.stdin.buffer.readline(3 * 1024 * 1024)
    request = json.loads(raw)
    password = request.pop('password', '')
    if os.geteuid() == 0:
        scope = {'__name__': 'proxy_workspace'}
        exec(WORKER, scope)
        return scope['main'](request)
    marker = '[VPS Pilot proxy sudo] '
    code = WORKER + ROOT_PROTOCOL
    child = subprocess.Popen(['/usr/bin/sudo','-S','-p',marker,'--','/usr/bin/python3','-I','-S','-u','-c',code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    output, errors, sent, prompted = b'', b'', False, False
    deadline = time.monotonic() + 180
    try:
        streams = [child.stdout, child.stderr]
        while streams:
            if time.monotonic() > deadline:
                raise ValueError('Proxy operation timed out. Inspect before retrying.')
            for stream in select.select(streams, [], [], .2)[0]:
                data = os.read(stream.fileno(), 8192)
                if not data:
                    streams.remove(stream)
                    continue
                if stream is child.stderr:
                    errors = (errors + data)[-8192:]
                    if marker.encode() in errors:
                        if prompted or not password:
                            raise ValueError('Sudo requires a valid password. Review again.')
                        child.stdin.write((password + '\n').encode()); child.stdin.flush()
                        password = ''; prompted = True; errors = b''
                else:
                    output += data
                    if len(output) > 3 * 1024 * 1024:
                        raise ValueError('Proxy output limit exceeded')
                    if not sent and b'VPS_PROXY_READY\n' in output:
                        output = output.split(b'VPS_PROXY_READY\n', 1)[1]
                        child.stdin.write((json.dumps(request) + '\n').encode()); child.stdin.flush(); child.stdin.close(); sent = True
        child.wait(timeout=3)
        if not sent or child.returncode:
            raise ValueError('Administrator command failed. Check sudo access and review again.')
        return json.loads(output)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL); child.wait()

try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as e:
    print(json.dumps({'error':str(e) if isinstance(e, ValueError) else 'Proxy operation failed; inspect before retrying'}))
