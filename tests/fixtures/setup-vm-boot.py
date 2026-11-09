import os
from pathlib import Path
if os.geteuid() != 0 or not Path('/.dockerenv').is_file():
    raise SystemExit('Run inside the disposable VPS Pilot fixture container only')
"""Run only inside the labelled disposable setup fixture; endpoints are loopback-only."""
import pathlib,subprocess,json,time,os,signal,hashlib
w=pathlib.Path('/fixture');w.mkdir(exist_ok=True);os.chmod(w,0o700)
base='https://cloud.debian.org/images/cloud/bookworm/latest/'
name='debian-12-genericcloud-arm64.qcow2'
if not (w/'base.qcow2').exists(): subprocess.run(['curl','-fSL',base+name,'-o',str(w/'base.qcow2')],check=True,stdout=subprocess.DEVNULL)
sums=subprocess.check_output(['curl','-fsSL',base+'SHA512SUMS']).decode()
expected=next(line.split()[0] for line in sums.splitlines() if line.split()[-1].lstrip('*')==name)
assert hashlib.sha512((w/'base.qcow2').read_bytes()).hexdigest()==expected
if not (w/'key').exists(): subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(w/'key')],check=True)
pub=(w/'key.pub').read_text().strip()
(w/'user-data').write_text('#cloud-config\ndisable_root: false\nssh_pwauth: true\nusers:\n - name: root\n   lock_passwd: false\n   ssh_authorized_keys: ["'+pub+'"]\n - name: fixture\n   sudo: ALL=(ALL) NOPASSWD:ALL\n   groups: sudo\n   shell: /bin/bash\n   ssh_authorized_keys: ["'+pub+'"]\npackages: [ufw, python3, sudo, curl, ca-certificates, gpgv, git]\nruncmd:\n - [touch, /root/vps-pilot-disposable-vm]\n')
(w/'meta-data').write_text('instance-id: vps-pilot-security-fixture\nlocal-hostname: pilot-fixture\n')
subprocess.run(['genisoimage','-output',str(w/'seed.iso'),'-volid','cidata','-joliet','-rock',str(w/'user-data'),str(w/'meta-data')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if not (w/'disk.qcow2').exists(): subprocess.run(['qemu-img','create','-f','qcow2','-F','qcow2','-b',str(w/'base.qcow2'),str(w/'disk.qcow2'),'24G'],check=True,stdout=subprocess.DEVNULL)
args=['qemu-system-aarch64','-machine','virt','-cpu','max','-accel','tcg,thread=multi','-m','2048','-smp','2','-nographic','-bios','/usr/share/qemu-efi-aarch64/QEMU_EFI.fd','-drive','file='+str(w/'disk.qcow2')+',format=qcow2,if=virtio','-drive','file='+str(w/'seed.iso')+',format=raw,media=cdrom,if=virtio','-netdev','user,id=n,hostfwd=tcp:0.0.0.0:2222-:22,hostfwd=tcp:0.0.0.0:2223-:52022','-device','virtio-net-pci,netdev=n,romfile=','-monitor','none']
with (w/'console.log').open('w') as log:
 p=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT)
 try:
  for i in range(600):
   result=subprocess.run(['ssh','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+str(w/'known_hosts'),'-o','BatchMode=yes','-o','ConnectTimeout=2','-i',str(w/'key'),'-p','2222','root@127.0.0.1','test -f /root/vps-pilot-disposable-vm'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   if result.returncode!=0:
    result=subprocess.run(['ssh','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(w/'known_hosts'),'-o','HostKeyAlias=[127.0.0.1]:2222','-o','BatchMode=yes','-o','ConnectTimeout=2','-i',str(w/'key'),'-p','2223','fixture@127.0.0.1','sudo -n test -f /root/vps-pilot-disposable-vm'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   if result.returncode==0: print('Disposable Debian VM ready',flush=True);break
   if p.poll() is not None: raise RuntimeError('VM exited')
   time.sleep(2)
  else: raise RuntimeError('VM boot timed out')
  (w/'ready').touch()
  p.wait()
 finally:
  p.terminate()
