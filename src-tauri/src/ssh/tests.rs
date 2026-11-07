use super::*;
use russh::{
    keys::{self, Algorithm, PrivateKey},
    server::{self, Server as _},
};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Notify},
    task::JoinHandle,
};

const FIXTURE_PASSWORD: &str = "fixture-only-password";
#[cfg(unix)]
const ADMIN_FIXTURE_PASSWORD: &str = "fixture-admin-sudo-password";
#[derive(Clone)]
struct TestServer {
    auth_count: Arc<AtomicUsize>,
    pause: Option<Arc<Notify>>,
    accepted_key: Option<keys::PublicKey>,
    allow_none: bool,
    explicit_user: Option<String>,
    explicit_key: Option<keys::PublicKey>,
    sudo_channels: std::collections::HashSet<russh::ChannelId>,
    monitor_channels: std::collections::HashSet<russh::ChannelId>,
    configuration_channels: std::collections::HashSet<russh::ChannelId>,
    install_channels: std::collections::HashSet<russh::ChannelId>,
    install_input: std::collections::HashMap<russh::ChannelId, Vec<u8>>,
    install_home: Option<std::path::PathBuf>,
    install_wrapper: Option<std::path::PathBuf>,
    install_requests: Arc<Mutex<Vec<Vec<u8>>>>,
    admin_channels: std::collections::HashSet<russh::ChannelId>,
    admin_input: std::collections::HashMap<russh::ChannelId, Vec<u8>>,
    admin_wrapper: Option<std::path::PathBuf>,
    admin_requests: Arc<Mutex<Vec<Vec<u8>>>>,
    sudo_verify_channels: std::collections::HashSet<russh::ChannelId>,
    sudo_verify_input: std::collections::HashMap<russh::ChannelId, Vec<u8>>,
    root_password: bool,
    gate_explicit_key_on_install: bool,
    channels_closed: Arc<AtomicUsize>,
    open_pause: Arc<Mutex<Option<Arc<Notify>>>>,
    channel_opens: Arc<AtomicUsize>,
    monitor_requests: Arc<AtomicUsize>,
    commands: Arc<Mutex<Vec<String>>>,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    sudo_inputs: Arc<AtomicUsize>,
    service_snapshot: Arc<Mutex<String>>,
}
impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl TestServer {
    fn authorized_key_present(&self, public: &keys::PublicKey) -> bool {
        let Some(home) = &self.install_home else {
            return false;
        };
        let Ok(text) = std::fs::read_to_string(home.join(".ssh/authorized_keys")) else {
            return false;
        };
        let Ok(wanted) = public.to_openssh() else {
            return false;
        };
        let parts: Vec<&str> = wanted.split_whitespace().collect();
        if parts.len() < 2 {
            return false;
        }
        let needle = format!("{} {}", parts[0], parts[1]);
        text.lines().any(|line| line.contains(&needle))
    }
}
impl server::Handler for TestServer {
    type Error = russh::Error;
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channel_opens.fetch_add(1, Ordering::SeqCst);
        let pause = self.open_pause.lock().unwrap().clone();
        if let Some(pause) = pause {
            pause.notified().await;
        }
        reply.accept().await;
        Ok(())
    }
    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.sizes.lock().unwrap().push((cols, rows));
        session.channel_success(channel)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"fixture shell ready".to_vec())?;
        Ok(())
    }
    async fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.admin_channels.contains(&channel) {
            let complete = {
                let buffer = self.admin_input.entry(channel).or_default();
                if buffer.len() + data.len() > 65536 {
                    return Ok(());
                }
                buffer.extend_from_slice(data);
                if serde_json::from_slice::<serde_json::Value>(buffer).is_ok() {
                    Some(buffer.clone())
                } else {
                    None
                }
            };
            if let Some(request) = complete {
                self.admin_input.remove(&channel);
                self.admin_requests.lock().unwrap().push(request.clone());
                let output = self.admin_wrapper.as_ref().map(|wrapper| {
                    std::process::Command::new("python3")
                        .arg(wrapper)
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .and_then(|mut child| {
                            use std::io::Write as _;
                            child.stdin.take().unwrap().write_all(&request)?;
                            child.wait_with_output()
                        })
                });
                match output {
                    Some(Ok(output)) => {
                        if !output.stdout.is_empty() {
                            session.data(channel, output.stdout)?;
                        }
                        session.exit_status_request(
                            channel,
                            output.status.code().unwrap_or(1) as u32,
                        )?;
                    }
                    _ => {
                        session.data(channel, br#"{"ok":false,"reason":"io_error"}"#.to_vec())?;
                        session.exit_status_request(channel, 1)?;
                    }
                }
                session.close(channel)?;
            }
            return Ok(());
        }
        #[cfg(unix)]
        if self.sudo_verify_channels.contains(&channel) {
            let complete = {
                let buffer = self.sudo_verify_input.entry(channel).or_default();
                buffer.extend_from_slice(data);
                buffer.ends_with(b"\n")
            };
            if complete {
                let request = self.sudo_verify_input.remove(&channel).unwrap_or_default();
                if request == format!("{ADMIN_FIXTURE_PASSWORD}\n").as_bytes() {
                    session.data(channel, b"0\n".to_vec())?;
                    session.exit_status_request(channel, 0)?;
                } else {
                    session.exit_status_request(channel, 1)?;
                }
                session.close(channel)?;
            }
            return Ok(());
        }
        if self.install_channels.contains(&channel) {
            let complete = {
                let buffer = self.install_input.entry(channel).or_default();
                if buffer.len() + data.len() > 65536 {
                    return Ok(());
                }
                buffer.extend_from_slice(data);
                if serde_json::from_slice::<serde_json::Value>(buffer).is_ok() {
                    Some(buffer.clone())
                } else {
                    None
                }
            };
            if let Some(request) = complete {
                self.install_input.remove(&channel);
                self.install_requests.lock().unwrap().push(request.clone());
                let output = self.install_wrapper.as_ref().map(|wrapper| {
                    std::process::Command::new("python3")
                        .arg(wrapper)
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .and_then(|mut child| {
                            use std::io::Write as _;
                            child.stdin.take().unwrap().write_all(&request)?;
                            child.wait_with_output()
                        })
                });
                match output {
                    Some(Ok(output)) => {
                        if !output.stdout.is_empty() {
                            session.data(channel, output.stdout)?;
                        }
                        session.exit_status_request(
                            channel,
                            output.status.code().unwrap_or(1) as u32,
                        )?;
                    }
                    _ => {
                        session.data(channel, br#"{"ok":false,"reason":"io_error"}"#.to_vec())?;
                        session.exit_status_request(channel, 1)?;
                    }
                }
                session.close(channel)?;
            }
            return Ok(());
        }
        if self.configuration_channels.contains(&channel) {
            // Keep the read pending until the client cancels; never execute Python.
            return Ok(());
        }
        if self.monitor_channels.contains(&channel) {
            assert_eq!(data, b"sample\n");
            let index = self.monitor_requests.fetch_add(1, Ordering::SeqCst) as u64;
            let mut frame = serde_json::to_vec(&serde_json::json!({
                "uptime": 1000 + index, "cpuTotal": 2000 + index * 100, "cpuIdle": 1000 + index * 50,
                "memoryTotal": 8192, "memoryAvailable": 4096, "swapTotal": 0, "swapFree": 0,
                "networkInterface": "eth0", "networkReceived": 100 + index * 10, "networkSent": 200 + index * 10,
                "diskRead": 100 + index * 20, "diskWritten": 200 + index * 20,
                "capacity": {"total": 10000, "free": 8000, "available": 7000}, "capacityAge": index
            })).unwrap();
            frame.push(b'\n');
            session.data(channel, frame[..40].to_vec())?;
            session.data(channel, frame[40..].to_vec())?;
        } else if self.sudo_channels.remove(&channel) {
            self.sudo_inputs.fetch_add(1, Ordering::SeqCst);
            if data == b"fixture-sudo-password\n" {
                session.data(channel, b"privileged fixture output".to_vec())?;
                session.exit_status_request(channel, 0)?;
                session.close(channel)?;
            } else {
                session.extended_data(channel, 1, actions::SUDO_PROMPT.as_bytes().to_vec())?;
            }
        } else {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        _: russh::ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.sizes.lock().unwrap().push((cols, rows));
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.commands
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(data).into_owned());
        session.channel_success(channel)?;
        if data == configuration::command().as_bytes() {
            self.configuration_channels.insert(channel);
            return Ok(());
        }
        #[cfg(unix)]
        if data == setup_access::install_key::command().as_bytes()
            || data.starts_with(b"exec runuser -u ")
        {
            self.install_channels.insert(channel);
            return Ok(());
        }
        #[cfg(unix)]
        if data == setup_access::admin::command().as_bytes() {
            self.admin_channels.insert(channel);
            return Ok(());
        }
        #[cfg(unix)]
        if data == setup_access::admin::SUDO_TEST.as_bytes() {
            self.sudo_verify_channels.insert(channel);
            return Ok(());
        }
        if data == monitor::command().as_bytes() {
            self.monitor_channels.insert(channel);
            return Ok(());
        }
        if data == services::probe("app.service").as_bytes() {
            session.data(
                channel,
                self.service_snapshot.lock().unwrap().as_bytes().to_vec(),
            )?;
            session.exit_status_request(channel, 0)?;
            session.close(channel)?;
            return Ok(());
        }
        if data.starts_with(b"sudo ")
            && !data
                .windows(b"cached.service".len())
                .any(|part| part == b"cached.service")
        {
            self.sudo_channels.insert(channel);
            session.extended_data(channel, 1, b"[VPS Pilot su".to_vec())?;
            session.extended_data(channel, 1, b"do password] ".to_vec())?;
            return Ok(());
        }
        session.data(channel, b"first packet".to_vec())?;
        session.data(channel, b"second packet".to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }
    async fn channel_close(
        &mut self,
        channel: russh::ChannelId,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.configuration_channels.remove(&channel);
        self.install_channels.remove(&channel);
        self.install_input.remove(&channel);
        self.admin_channels.remove(&channel);
        self.admin_input.remove(&channel);
        self.sudo_verify_channels.remove(&channel);
        self.sudo_verify_input.remove(&channel);
        self.channels_closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn auth_none(&mut self, user: &str) -> Result<server::Auth, Self::Error> {
        Ok(if self.allow_none && user == "tester" {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<server::Auth, Self::Error> {
        self.auth_count.fetch_add(1, Ordering::SeqCst);
        let tester_key = user == "tester" && self.accepted_key.as_ref() == Some(key.public_key);
        let explicit_key = self.explicit_user.as_deref() == Some(user)
            && self.explicit_key.as_ref() == Some(key.public_key)
            && (!self.gate_explicit_key_on_install || self.authorized_key_present(key.public_key));
        Ok(if tester_key || explicit_key {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.auth_count.fetch_add(1, Ordering::SeqCst);
        if let Some(pause) = &self.pause {
            pause.notified().await;
        }
        Ok(
            if (user == "tester" || (self.root_password && user == "root"))
                && password == FIXTURE_PASSWORD
            {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }
}
struct InstallFixture {
    home: PathBuf,
    wrapper: PathBuf,
    requests: Arc<Mutex<Vec<Vec<u8>>>>,
    admin_wrapper: Option<PathBuf>,
    admin_requests: Arc<Mutex<Vec<Vec<u8>>>>,
    root_password: bool,
}
struct Fixture {
    port: u16,
    monitor_requests: Arc<AtomicUsize>,
    channels_closed: Arc<AtomicUsize>,
    open_pause: Arc<Mutex<Option<Arc<Notify>>>>,
    channel_opens: Arc<AtomicUsize>,
    auth_count: Arc<AtomicUsize>,
    shutdown: server::RunningServerHandle,
    task: Option<JoinHandle<()>>,
    commands: Arc<Mutex<Vec<String>>>,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    sudo_inputs: Arc<AtomicUsize>,
    service_snapshot: Arc<Mutex<String>>,
    install_requests: Arc<Mutex<Vec<Vec<u8>>>>,
    admin_requests: Arc<Mutex<Vec<Vec<u8>>>>,
}
impl Fixture {
    async fn start(port: u16, pause: Option<Arc<Notify>>) -> Self {
        Self::start_with_auth(port, pause, None, false).await
    }
    async fn start_with_auth(
        port: u16,
        pause: Option<Arc<Notify>>,
        accepted_key: Option<keys::PublicKey>,
        allow_none: bool,
    ) -> Self {
        Self::start_with_target_key(port, pause, accepted_key, allow_none, None, None, None).await
    }
    async fn start_with_target_key(
        port: u16,
        pause: Option<Arc<Notify>>,
        accepted_key: Option<keys::PublicKey>,
        allow_none: bool,
        explicit_user: Option<String>,
        explicit_key: Option<keys::PublicKey>,
        host_key: Option<PrivateKey>,
    ) -> Self {
        Self::start_with_options(
            port,
            pause,
            accepted_key,
            allow_none,
            explicit_user,
            explicit_key,
            host_key,
            false,
            None,
        )
        .await
    }
    #[cfg(unix)]
    async fn start_for_install(
        port: u16,
        user: String,
        key: keys::PublicKey,
        host_key: Option<PrivateKey>,
        home: PathBuf,
    ) -> Self {
        let parent = home.parent().unwrap().to_path_buf();
        let script = parent.join("install_key.py");
        std::fs::write(&script, setup_access::install_key::SCRIPT).unwrap();
        let wrapper = parent.join("install-wrapper.py");
        std::fs::write(
            &wrapper,
            setup_access::install_key::test_wrapper_source(&home, &user, &script),
        )
        .unwrap();
        Self::start_with_options(
            port,
            None,
            None,
            false,
            Some(user),
            Some(key),
            host_key,
            true,
            Some(InstallFixture {
                home,
                wrapper,
                requests: Arc::new(Mutex::new(Vec::new())),
                admin_wrapper: None,
                admin_requests: Arc::new(Mutex::new(Vec::new())),
                root_password: false,
            }),
        )
        .await
    }
    #[cfg(unix)]
    async fn start_for_admin(
        port: u16,
        admin_user: String,
        key: keys::PublicKey,
        host_key: Option<PrivateKey>,
        home: PathBuf,
    ) -> Self {
        let parent = home.parent().unwrap().to_path_buf();
        let key_script = parent.join("install_key.py");
        std::fs::write(&key_script, setup_access::install_key::SCRIPT).unwrap();
        let key_wrapper = parent.join("install-wrapper.py");
        std::fs::write(
            &key_wrapper,
            setup_access::install_key::test_wrapper_source(&home, &admin_user, &key_script),
        )
        .unwrap();
        let admin_wrapper = parent.join("admin-wrapper.py");
        std::fs::write(
            &admin_wrapper,
            setup_access::admin::test_wrapper_source(&home, &admin_user),
        )
        .unwrap();
        Self::start_with_options(
            port,
            None,
            None,
            false,
            Some(admin_user),
            Some(key),
            host_key,
            true,
            Some(InstallFixture {
                home,
                wrapper: key_wrapper,
                requests: Arc::new(Mutex::new(Vec::new())),
                admin_wrapper: Some(admin_wrapper),
                admin_requests: Arc::new(Mutex::new(Vec::new())),
                root_password: true,
            }),
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn start_with_options(
        port: u16,
        pause: Option<Arc<Notify>>,
        accepted_key: Option<keys::PublicKey>,
        allow_none: bool,
        explicit_user: Option<String>,
        explicit_key: Option<keys::PublicKey>,
        host_key: Option<PrivateKey>,
        gate_explicit_key_on_install: bool,
        install: Option<InstallFixture>,
    ) -> Self {
        let socket = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let auth_count = Arc::new(AtomicUsize::new(0));
        let service_snapshot = Arc::new(Mutex::new("=== OS ===\nID=debian\nVERSION_ID=\"12\"\n=== Architecture ===\nx86_64\nId=app.service\nLoadState=loaded\nNeedDaemonReload=no\nType=simple\nDropInPaths=\nJob=\nRequiredBy=\nBoundBy=\nConsistsOf=\nFragmentPath=/etc/systemd/system/app.service\nRefuseManualStart=no\nRefuseManualStop=no\nActiveState=active\n=== Dependents ===\napp.service\n=== Unit file revision ===\n1:2:3:4:5\n".into()));
        let sudo_inputs = Arc::new(AtomicUsize::new(0));
        let commands = Arc::new(Mutex::new(Vec::new()));
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let monitor_requests = Arc::new(AtomicUsize::new(0));
        let channels_closed = Arc::new(AtomicUsize::new(0));
        let open_pause = Arc::new(Mutex::new(None));
        let channel_opens = Arc::new(AtomicUsize::new(0));
        let install_requests = install
            .as_ref()
            .map(|install| install.requests.clone())
            .unwrap_or_default();
        let install_home = install.as_ref().map(|install| install.home.clone());
        let install_wrapper = install.as_ref().map(|install| install.wrapper.clone());
        let admin_wrapper = install
            .as_ref()
            .and_then(|install| install.admin_wrapper.clone());
        let admin_requests = install
            .as_ref()
            .map(|install| install.admin_requests.clone())
            .unwrap_or_default();
        let root_password = install
            .as_ref()
            .is_some_and(|install| install.root_password);
        let mut server = TestServer {
            configuration_channels: Default::default(),
            channels_closed: channels_closed.clone(),
            open_pause: open_pause.clone(),
            channel_opens: channel_opens.clone(),
            monitor_channels: Default::default(),
            monitor_requests: monitor_requests.clone(),
            sudo_channels: Default::default(),
            install_channels: Default::default(),
            install_input: Default::default(),
            install_home: install_home.clone(),
            install_wrapper,
            install_requests: install_requests.clone(),
            admin_channels: Default::default(),
            admin_input: Default::default(),
            admin_wrapper,
            admin_requests: admin_requests.clone(),
            sudo_verify_channels: Default::default(),
            sudo_verify_input: Default::default(),
            root_password,
            gate_explicit_key_on_install,
            service_snapshot: service_snapshot.clone(),
            sudo_inputs: sudo_inputs.clone(),
            commands: commands.clone(),
            sizes: sizes.clone(),
            auth_count: auth_count.clone(),
            pause,
            accepted_key,
            allow_none,
            explicit_user,
            explicit_key,
        };
        let config = Arc::new(server::Config {
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            keys: vec![host_key.unwrap_or_else(|| {
                PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
            })],
            ..Default::default()
        });
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let running = server.run_on_socket(config, &socket);
            let _ = sender.send(running.handle());
            let _ = running.await;
        });
        Self {
            channels_closed,
            open_pause,
            channel_opens,
            port,
            monitor_requests,
            auth_count,
            shutdown: receiver.await.unwrap(),
            task: Some(task),
            commands,
            sizes,
            sudo_inputs,
            service_snapshot,
            install_requests,
            admin_requests,
        }
    }
    async fn stop(&mut self) {
        self.shutdown.shutdown("Fixture stopped".into());
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown.shutdown("Fixture stopped".into());
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
fn input(port: u16) -> ProfileInput {
    ProfileInput {
        id: None,
        name: "Local SSH fixture".into(),
        host: "127.0.0.1".into(),
        port,
        username: "tester".into(),
        identity_file: None,
        password_allowed: true,
    }
}
fn service() -> (tempfile::TempDir, SshService) {
    let dir = tempfile::tempdir().unwrap();
    let mut service = SshService::new(dir.path().join("profiles.json"));
    // Only the in-process disposable SSH fixtures opt into exercising mutators.
    service.changes_enabled = true;
    (dir, service)
}

#[test]
fn validates_and_normalizes_profiles_without_accepting_secret_fields() {
    let mut value = input(22);
    value.host = " SERVER.Example.com. ".into();
    assert_eq!(value.validate().unwrap().host, "server.example.com");
    for host in [
        "https://host",
        "user@host",
        "host:22",
        "host/dir",
        "host;command",
        "-host",
    ] {
        let mut value = input(22);
        value.host = host.into();
        assert!(value.validate().is_err());
    }
    let mut value = input(22);
    value.host = "::1".into();
    assert!(value.validate().is_ok());
    assert!(input(0).validate().is_err());
    let raw = serde_json::json!({ "id": null, "name": "test", "host": "localhost", "port": 22, "username": "tester", "password": "not-profile-data" });
    assert!(serde_json::from_value::<ProfileInput>(raw).is_err());
}

#[tokio::test]
async fn persists_metadata_atomically_and_does_not_overwrite_corrupt_storage() {
    let (dir, service) = service();
    let profile = service.save_profile(input(22)).await.unwrap();
    let reloaded = SshService::new(dir.path().join("profiles.json"));
    assert_eq!(reloaded.profiles().unwrap()[0].id, profile.id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join("profiles.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let bytes = std::fs::read_to_string(dir.path().join("profiles.json")).unwrap();
    assert!(!bytes.contains("\"password\":"));
    assert!(!bytes.contains("\"passphrase\":"));
    assert!(!bytes.contains(FIXTURE_PASSWORD));
    std::fs::write(dir.path().join("profiles.json"), "invalid").unwrap();
    let invalid = SshService::new(dir.path().join("profiles.json"));
    assert!(invalid.save_profile(input(22)).await.is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("profiles.json")).unwrap(),
        "invalid"
    );
}

#[tokio::test]
async fn unknown_hosts_require_trust_and_authentication_is_isolated_per_profile() {
    let fixture = Fixture::start(0, None).await;
    let (dir, service) = service();
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    assert_eq!(inspection.status, "unknown");
    assert!(service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into()
        )
        .await
        .is_err());
    assert_eq!(fixture.auth_count.load(Ordering::SeqCst), 0);
    service
        .trust(&profile.id, &inspection.challenge_id)
        .await
        .unwrap();
    service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into(),
        )
        .await
        .unwrap();
    assert_eq!(service.statuses().await[0].status, "connected");
    let mut edit = input(fixture.port);
    edit.id = Some(profile.id.clone());
    edit.port = if fixture.port == u16::MAX {
        1
    } else {
        fixture.port + 1
    };
    assert!(service.save_profile(edit).await.is_err());
    assert!(service.delete_profile(&profile.id).await.is_err());
    let second = service.save_profile(input(fixture.port)).await.unwrap();
    let known = service.inspect(&second.id).await.unwrap();
    assert_eq!(known.status, "known");
    assert!(service
        .connect(
            &second.id,
            &known.challenge_id,
            "wrong fixture password".into()
        )
        .await
        .is_err());
    assert_eq!(
        service
            .statuses()
            .await
            .iter()
            .find(|item| item.profile_id == profile.id)
            .unwrap()
            .status,
        "connected"
    );
    service.disconnect(&profile.id).await.unwrap();
    assert_eq!(service.statuses().await[0].status, "disconnected");
    let stored = std::fs::read_to_string(dir.path().join("profiles.json")).unwrap();
    assert!(!stored.contains(FIXTURE_PASSWORD));
    assert_eq!(
        SshService::new(dir.path().join("profiles.json"))
            .statuses()
            .await[0]
            .status,
        "disconnected"
    );
}

#[tokio::test]
async fn renaming_a_connected_profile_preserves_its_identity_and_connection() {
    let fixture = Fixture::start(0, None).await;
    let (dir, service) = service();
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &inspection.challenge_id)
        .await
        .unwrap();
    service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into(),
        )
        .await
        .unwrap();
    let mut rename = input(fixture.port);
    rename.id = Some(profile.id.clone());
    rename.name = "Renamed VPS".into();
    let renamed = service.save_profile(rename).await.unwrap();
    assert_eq!(renamed.id, profile.id);
    assert_eq!(renamed.revision, profile.revision);
    assert_eq!(renamed.name, "Renamed VPS");
    assert_eq!(service.profiles().unwrap()[0].name, "Renamed VPS");
    assert_eq!(service.statuses().await[0].status, "connected");
    let stored = std::fs::read_to_string(dir.path().join("profiles.json")).unwrap();
    assert!(stored.contains("\"name\": \"Renamed VPS\""));
    let mut endpoint_change = input(fixture.port);
    endpoint_change.id = Some(profile.id.clone());
    endpoint_change.host = "127.0.0.2".into();
    assert!(service.save_profile(endpoint_change).await.is_err());
    assert_eq!(service.statuses().await[0].status, "connected");
    service.disconnect(&profile.id).await.unwrap();
}

#[tokio::test]
async fn host_key_changes_between_review_and_authentication_never_receive_a_password() {
    let mut fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let original = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &original.challenge_id)
        .await
        .unwrap();
    let port = fixture.port;
    fixture.stop().await;
    let replacement = Fixture::start(port, None).await;
    let error = service
        .connect(&profile.id, &original.challenge_id, FIXTURE_PASSWORD.into())
        .await
        .unwrap_err();
    assert!(error.contains("Authentication was not attempted"));
    assert_eq!(replacement.auth_count.load(Ordering::SeqCst), 0);
    let changed = service.inspect(&profile.id).await.unwrap();
    assert_eq!(changed.status, "changed");
    assert!(service
        .trust(&profile.id, &changed.challenge_id)
        .await
        .is_err());
    assert!(service
        .connect(&profile.id, &changed.challenge_id, FIXTURE_PASSWORD.into())
        .await
        .is_err());
    assert_eq!(replacement.auth_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn expired_or_wrong_challenges_and_edited_profiles_cannot_authenticate() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let inspected = service.inspect(&profile.id).await.unwrap();
    assert!(service.trust(&profile.id, "wrong token").await.is_err());
    service
        .trust(&profile.id, &inspected.challenge_id)
        .await
        .unwrap();
    assert!(service
        .connect(&profile.id, "wrong token", FIXTURE_PASSWORD.into())
        .await
        .is_err());
    service
        .runtime
        .lock()
        .await
        .challenges
        .get_mut(&profile.id)
        .unwrap()
        .issued = Instant::now() - Duration::from_secs(301);
    assert!(service
        .connect(
            &profile.id,
            &inspected.challenge_id,
            FIXTURE_PASSWORD.into()
        )
        .await
        .is_err());
    let next = service.inspect(&profile.id).await.unwrap();
    let mut edit = input(fixture.port);
    edit.id = Some(profile.id.clone());
    edit.name = "Edited profile".into();
    service.save_profile(edit).await.unwrap();
    assert!(service
        .connect(&profile.id, &next.challenge_id, FIXTURE_PASSWORD.into())
        .await
        .is_err());
    assert_eq!(fixture.auth_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancelling_authentication_cannot_publish_a_late_connection() {
    let pause = Arc::new(Notify::new());
    let fixture = Fixture::start(0, Some(pause.clone())).await;
    let (_dir, service) = service();
    let service = Arc::new(service);
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let inspected = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &inspected.challenge_id)
        .await
        .unwrap();
    let attempt = {
        let service = service.clone();
        let id = profile.id.clone();
        tokio::spawn(async move {
            service
                .connect(&id, &inspected.challenge_id, FIXTURE_PASSWORD.into())
                .await
        })
    };
    timeout(Duration::from_secs(3), async {
        while fixture.auth_count.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    service.disconnect(&profile.id).await.unwrap();
    pause.notify_one();
    assert!(attempt.await.unwrap().is_err());
    assert_eq!(service.statuses().await[0].status, "disconnected");
}

#[tokio::test]
async fn external_store_changes_cannot_overwrite_profiles_or_host_pins() {
    let dir = tempfile::tempdir().unwrap();
    let first = SshService::new(dir.path().join("profiles.json"));
    let second = SshService::new(dir.path().join("profiles.json"));
    let profile = first.save_profile(input(22)).await.unwrap();
    assert!(second.save_profile(input(23)).await.is_err());
    assert_eq!(
        SshService::new(dir.path().join("profiles.json"))
            .profiles()
            .unwrap()[0]
            .id,
        profile.id
    );
}

#[tokio::test]
async fn cancelling_a_stalled_handshake_returns_without_waiting_for_network_timeout() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let (_dir, service) = service();
    let service = Arc::new(service);
    let profile = service
        .save_profile(input(listener.local_addr().unwrap().port()))
        .await
        .unwrap();
    let attempt = {
        let service = service.clone();
        let id = profile.id.clone();
        tokio::spawn(async move { service.inspect(&id).await })
    };
    let (mut peer, _) = timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    service.disconnect(&profile.id).await.unwrap();
    assert!(timeout(Duration::from_secs(2), attempt)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    timeout(Duration::from_secs(2), async {
        use tokio::io::AsyncReadExt;
        let mut buffer = [0_u8; 512];
        while peer.read(&mut buffer).await.unwrap_or(0) != 0 {}
    })
    .await
    .expect("Cancelled handshake must close its TCP socket");
    assert_eq!(service.statuses().await[0].status, "disconnected");
}

#[tokio::test]
async fn storage_errors_do_not_hide_or_prevent_disconnecting_live_connections() {
    let fixture = Fixture::start(0, None).await;
    let (dir, service) = service();
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &inspection.challenge_id)
        .await
        .unwrap();
    service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into(),
        )
        .await
        .unwrap();
    std::fs::write(dir.path().join("profiles.json"), "corrupt fixture data").unwrap();
    assert!(service.profiles().is_err());
    assert_eq!(service.statuses().await[0].status, "connected");
    service.disconnect(&profile.id).await.unwrap();
    assert!(service.runtime.lock().await.connections.is_empty());
}

#[tokio::test]
async fn private_keys_with_and_without_passphrases_connect_without_a_server_password() {
    for encrypted in [false, true] {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let server = Fixture::start_with_auth(0, None, Some(key.public_key().clone()), false).await;
        let (dir, service) = service();
        let key_path = dir.path().join("identity");
        let file_key = if encrypted {
            key.encrypt(&mut rand::rng(), "fixture-key-passphrase")
                .unwrap()
        } else {
            key
        };
        std::fs::write(
            &key_path,
            file_key.to_openssh(Default::default()).unwrap().as_bytes(),
        )
        .unwrap();
        let mut draft = input(server.port);
        draft.identity_file = Some(key_path.to_string_lossy().into_owned());
        draft.password_allowed = false;
        let profile = service.save_profile(draft).await.unwrap();
        let review = service.inspect(&profile.id).await.unwrap();
        assert!(service
            .connect(&profile.id, &review.challenge_id, String::new())
            .await
            .is_err());
        assert_eq!(server.auth_count.load(Ordering::SeqCst), 0);
        service
            .trust(&profile.id, &review.challenge_id)
            .await
            .unwrap();
        let review = if encrypted {
            assert!(service
                .connect_with_credentials(
                    &profile.id,
                    &review.challenge_id,
                    String::new(),
                    Some("wrong-fixture-passphrase".into())
                )
                .await
                .is_err());
            assert_eq!(server.auth_count.load(Ordering::SeqCst), 0);
            service.inspect(&profile.id).await.unwrap()
        } else {
            review
        };
        service
            .connect_with_credentials(
                &profile.id,
                &review.challenge_id,
                String::new(),
                encrypted.then(|| "fixture-key-passphrase".into()),
            )
            .await
            .unwrap();
        assert_eq!(service.statuses().await[0].status, "connected");
        assert_eq!(server.auth_count.load(Ordering::SeqCst), 1);
        let saved = std::fs::read_to_string(dir.path().join("profiles.json")).unwrap();
        assert!(!saved.contains("fixture-key-passphrase"));
        assert!(!saved.contains("PRIVATE KEY"));
        service.disconnect(&profile.id).await.unwrap();
    }
}
#[tokio::test]
async fn servers_allowing_no_authentication_do_not_require_a_password() {
    let server = Fixture::start_with_auth(0, None, None, true).await;
    let (_dir, service) = service();
    let profile = service.save_profile(input(server.port)).await.unwrap();
    let review = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &review.challenge_id)
        .await
        .unwrap();
    service
        .connect(&profile.id, &review.challenge_id, String::new())
        .await
        .unwrap();
    assert_eq!(service.statuses().await[0].status, "connected");
    assert_eq!(server.auth_count.load(Ordering::SeqCst), 0);
    service.disconnect(&profile.id).await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn agent_signs_for_the_selected_key_without_reading_real_user_agents() {
    use russh::keys::agent::{client::AgentClient, server as agent_server};
    use tokio::net::UnixListener;
    use tokio_stream::wrappers::UnixListenerStream;
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let server = Fixture::start_with_auth(0, None, Some(key.public_key().clone()), false).await;
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("agent.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let agent_task = tokio::spawn(agent_server::serve(UnixListenerStream::new(listener), ()));
    let mut agent = AgentClient::connect_uds(&socket).await.unwrap();
    agent.add_identity(&key, &[]).await.unwrap();
    let handler = Client {
        expected: None,
        observed: Arc::new(AsyncMutex::new(None)),
    };
    // Pin the local fixture's public host key before asking the agent to sign.
    let (_dir, service) = service();
    let profile = service.save_profile(input(server.port)).await.unwrap();
    let review = service.inspect(&profile.id).await.unwrap();
    let mut handle = client::connect(
        Arc::new(client_config()),
        ("127.0.0.1", server.port),
        Client {
            expected: Some(review.observed),
            ..handler
        },
    )
    .await
    .unwrap();
    let unrelated = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    assert!(!auth::agent_auth(&mut handle, "tester", &socket, Some(unrelated.public_key())).await);
    assert_eq!(server.auth_count.load(Ordering::SeqCst), 0);
    assert!(auth::agent_auth(&mut handle, "tester", &socket, Some(key.public_key())).await);
    assert_eq!(server.auth_count.load(Ordering::SeqCst), 1);
    handle
        .disconnect(Disconnect::ByApplication, "done", "")
        .await
        .unwrap();
    agent_task.abort();
}

#[tokio::test]
async fn configured_key_only_connections_never_send_a_supplied_password() {
    let server = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let mut draft = input(server.port);
    draft.password_allowed = false;
    let profile = service.save_profile(draft).await.unwrap();
    let review = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &review.challenge_id)
        .await
        .unwrap();
    assert!(service
        .connect(&profile.id, &review.challenge_id, FIXTURE_PASSWORD.into())
        .await
        .is_err());
    assert_eq!(server.auth_count.load(Ordering::SeqCst), 0);
}

async fn fixture_connection(service: &SshService, fixture: &Fixture) -> Profile {
    let profile = service.save_profile(input(fixture.port)).await.unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &inspection.challenge_id)
        .await
        .unwrap();
    service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into(),
        )
        .await
        .unwrap();
    profile
}
fn stream_sink() -> (
    streams::Sink,
    tokio::sync::mpsc::UnboundedReceiver<streams::StreamEvent>,
) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    (Arc::new(move |event| sender.send(event).is_ok()), receiver)
}
async fn event(
    receiver: &mut tokio::sync::mpsc::UnboundedReceiver<streams::StreamEvent>,
) -> streams::StreamEvent {
    loop {
        let event = timeout(Duration::from_secs(3), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        if !matches!(event, streams::StreamEvent::Inspection { .. }) {
            return event;
        }
    }
}

#[tokio::test]
async fn configuration_cancel_closes_only_its_channel_and_allows_manual_retry() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service.statuses().await[0].connection_id.clone().unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { .. }
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();
    let early = uuid::Uuid::new_v4().to_string();
    service
        .configuration
        .cancel(&profile.id, &connection, &early)
        .unwrap();
    assert!(service
        .configuration_snapshot_request(&profile.id, &connection, &early)
        .await
        .err()
        .unwrap()
        .contains("canceled"));
    assert!(fixture.commands.lock().unwrap().is_empty());
    for expected in 1..=2 {
        let operation = uuid::Uuid::new_v4().to_string();
        let reading = service.configuration_snapshot_request(&profile.id, &connection, &operation);
        let cancel = async {
            timeout(Duration::from_secs(3), async {
                loop {
                    if fixture.commands.lock().unwrap().len() >= expected {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert!(service
                .configuration
                .cancel(&profile.id, "old-generation", &operation)
                .is_err());
            service
                .configuration
                .cancel(&profile.id, &connection, &operation)
                .unwrap();
        };
        let (result, ()) = timeout(Duration::from_secs(4), async {
            tokio::join!(reading, cancel)
        })
        .await
        .unwrap();
        assert!(result.err().unwrap().contains("canceled"));
        timeout(Duration::from_secs(2), async {
            while fixture.channels_closed.load(Ordering::SeqCst) < expected {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"still alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(
        matches!(event(&mut output).await, streams::StreamEvent::Data { data, .. } if data == b"still alive")
    );
    service.close_stream(&profile.id, &shell).await.unwrap();
}

#[tokio::test]
async fn configuration_cancel_during_channel_open_closes_late_confirmation_without_exec() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service.statuses().await[0].connection_id.clone().unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { .. }
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();
    let pause = Arc::new(Notify::new());
    *fixture.open_pause.lock().unwrap() = Some(pause.clone());
    let before = fixture.channel_opens.load(Ordering::SeqCst);
    let operation = uuid::Uuid::new_v4().to_string();
    let reading = service.configuration_snapshot_request(&profile.id, &connection, &operation);
    let cancel = async {
        timeout(Duration::from_secs(3), async {
            while fixture.channel_opens.load(Ordering::SeqCst) == before {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        service
            .configuration
            .cancel(&profile.id, &connection, &operation)
            .unwrap();
        pause.notify_one();
    };
    let (result, ()) = timeout(Duration::from_secs(4), async {
        tokio::join!(reading, cancel)
    })
    .await
    .unwrap();
    assert!(result.err().unwrap().contains("canceled"));
    timeout(Duration::from_secs(2), async {
        while fixture.channels_closed.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(fixture.commands.lock().unwrap().is_empty());
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"open race survived".to_vec()),
        )
        .await
        .unwrap();
    assert!(
        matches!(event(&mut output).await, streams::StreamEvent::Data { data, .. } if data == b"open race survived")
    );
    service.close_stream(&profile.id, &shell).await.unwrap();
}

#[tokio::test]
async fn real_pty_channels_resize_isolate_and_close_without_replaying_input() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let other = fixture_connection(&service, &fixture).await;
    let (sink, mut output) = stream_sink();
    let id = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    let first = event(&mut output).await;
    assert!(
        matches!(first, streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready")
    );
    assert!(service
        .control(&other.id, &id, streams::Control::Input(b"foreign".to_vec()))
        .await
        .is_err());
    service
        .control(&profile.id, &id, streams::Control::Ack(1))
        .await
        .unwrap();
    service
        .control(&profile.id, &id, streams::Control::Resize(120, 40))
        .await
        .unwrap();
    service
        .control(&profile.id, &id, streams::Control::Input(b"hello".to_vec()))
        .await
        .unwrap();
    assert!(
        matches!(event(&mut output).await, streams::StreamEvent::Data { data, .. } if data == b"hello")
    );
    assert!(fixture.sizes.lock().unwrap().contains(&(120, 40)));
    assert!(service.close_stream(&other.id, &id).await.is_err());
    service.disconnect(&profile.id).await.unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Closed { code: None, .. }
    ));
    assert!(service
        .runtime
        .lock()
        .await
        .connections
        .get(&other.id)
        .is_some_and(|handle| !handle.is_closed()));
    assert!(fixture.commands.lock().unwrap().is_empty());
}
#[tokio::test]
async fn app_output_requires_acknowledgement_and_reports_exit_status() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let (sink, mut output) = stream_sink();
    let command = discovery::InspectionKind::Processes.command();
    let id = service
        .start_stream(&profile.id, None, Some(&command), sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { sequence: 1, .. }
    ));
    assert!(timeout(Duration::from_millis(100), output.recv())
        .await
        .is_err());
    service
        .control(&profile.id, &id, streams::Control::Ack(999))
        .await
        .unwrap();
    assert!(timeout(Duration::from_millis(100), output.recv())
        .await
        .is_err());
    service
        .control(&profile.id, &id, streams::Control::Ack(1))
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { sequence: 2, .. }
    ));
    service
        .control(&profile.id, &id, streams::Control::Ack(2))
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Closed { code: Some(0), .. }
    ));
    assert_eq!(*fixture.commands.lock().unwrap(), vec![command]);
}
#[tokio::test]
async fn terminal_limits_and_cancellation_close_only_the_selected_session() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    assert!(streams::dimensions(0, 24).is_err());
    assert!(streams::dimensions(80, 301).is_err());
    for _ in 0..12 {
        let (sink, _) = stream_sink();
        // Keep receivers alive so actors don't immediately dispose themselves.
        let sink: streams::Sink = Arc::new(move |event| {
            sink(event);
            true
        });
        service
            .start_stream(&profile.id, Some((80, 24)), None, sink)
            .await
            .unwrap();
    }
    let (sink, _) = stream_sink();
    assert!(service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .is_err());
    let id = service
        .runtime
        .lock()
        .await
        .streams
        .keys()
        .next()
        .unwrap()
        .clone();
    service.close_stream(&profile.id, &id).await.unwrap();
    assert_eq!(service.runtime.lock().await.streams.len(), 11);
    service.disconnect(&profile.id).await.unwrap();
    assert!(service.runtime.lock().await.streams.is_empty());
}

#[tokio::test]
async fn approval_is_bound_to_server_connection_expiration_and_single_use() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let other = fixture_connection(&service, &fixture).await;
    let action = actions::AppAction::DiskScan {
        path: "/srv".into(),
    };
    let plan = service
        .review_action(&profile.id, action.clone())
        .await
        .unwrap();
    let (sink, _) = stream_sink();
    assert!(service
        .execute_action(&other.id, &plan.id, "".into(), sink.clone())
        .await
        .is_err());
    assert!(service
        .execute_action(&profile.id, &plan.id, "".into(), sink.clone())
        .await
        .is_err());
    assert!(fixture.commands.lock().unwrap().is_empty());
    let plan = service
        .review_action(&profile.id, action.clone())
        .await
        .unwrap();
    service
        .runtime
        .lock()
        .await
        .approvals
        .get_mut(&plan.id)
        .unwrap()
        .issued = Instant::now() - Duration::from_secs(121);
    assert!(service
        .execute_action(&profile.id, &plan.id, "".into(), sink.clone())
        .await
        .is_err());
    let plan = service
        .review_action(&profile.id, action.clone())
        .await
        .unwrap();
    service.disconnect(&profile.id).await.unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into(),
        )
        .await
        .unwrap();
    assert!(service
        .execute_action(&profile.id, &plan.id, "".into(), sink.clone())
        .await
        .is_err());
    let plan = service.review_action(&profile.id, action).await.unwrap();
    let (sink, mut output) = stream_sink();
    let id = service
        .execute_action(&profile.id, &plan.id, "".into(), sink.clone())
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { .. }
    ));
    assert!(service
        .execute_action(&profile.id, &plan.id, "".into(), sink)
        .await
        .is_err());
    service.close_stream(&profile.id, &id).await.unwrap();
    assert_eq!(fixture.commands.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn sudo_secret_uses_stdin_only_after_a_prompt_and_never_enters_output() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let plan = service
        .review_action(&profile.id, actions::AppAction::UfwStatus {})
        .await
        .unwrap();
    assert!(plan.privileged);
    let (sink, mut output) = stream_sink();
    let id = service
        .execute_action(&profile.id, &plan.id, "fixture-sudo-password".into(), sink)
        .await
        .unwrap();
    match event(&mut output).await {
        streams::StreamEvent::Data { data, sequence, .. } => {
            assert!(data == b"privileged fixture output");
            service
                .control(&profile.id, &id, streams::Control::Ack(sequence))
                .await
                .unwrap();
        }
        _ => panic!("Expected privileged fixture output"),
    }
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Closed { code: Some(0), .. }
    ));
    assert_eq!(fixture.sudo_inputs.load(Ordering::SeqCst), 1);
    assert!(fixture
        .commands
        .lock()
        .unwrap()
        .iter()
        .all(|command| !command.contains("fixture-sudo-password")));
}
#[tokio::test]
async fn missing_or_wrong_sudo_password_ends_the_attempt_without_retries() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    for password in ["", "incorrect"] {
        let plan = service
            .review_action(&profile.id, actions::AppAction::UfwStatus {})
            .await
            .unwrap();
        let (sink, mut output) = stream_sink();
        service
            .execute_action(&profile.id, &plan.id, password.into(), sink)
            .await
            .unwrap();
        assert!(matches!(
            event(&mut output).await,
            streams::StreamEvent::Closed { code: None, .. }
        ));
    }
    assert_eq!(fixture.sudo_inputs.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.commands.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn cached_sudo_still_requires_a_fresh_plan_and_never_receives_a_password() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let action = actions::AppAction::ServiceLogs {
        unit: "cached.service".into(),
    };
    for _ in 0..2 {
        let plan = service
            .review_action(&profile.id, action.clone())
            .await
            .unwrap();
        assert!(plan.command.starts_with("sudo -S"));
        let (sink, mut output) = stream_sink();
        let id = service
            .execute_action(&profile.id, &plan.id, "unused-secret".into(), sink)
            .await
            .unwrap();
        loop {
            match event(&mut output).await {
                streams::StreamEvent::Metrics { .. } => unreachable!("not a monitoring stream"),
                streams::StreamEvent::Inspection { .. } => {
                    unreachable!("event helper filters reports")
                }
                streams::StreamEvent::Data { sequence, .. } => service
                    .control(&profile.id, &id, streams::Control::Ack(sequence))
                    .await
                    .unwrap(),
                streams::StreamEvent::Closed { code, .. } => {
                    assert_eq!(code, Some(0));
                    break;
                }
            }
        }
    }
    assert_eq!(fixture.commands.lock().unwrap().len(), 2);
    assert_eq!(fixture.sudo_inputs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn service_mutations_recheck_state_and_serialize_changes() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let action = actions::AppAction::ServiceChange {
        unit: "app.service".into(),
        operation: services::ServiceOperation::Restart,
    };
    let plan = service
        .review_action(&profile.id, action.clone())
        .await
        .unwrap();
    assert!(plan.evidence.is_some());
    let snapshot = fixture.service_snapshot.lock().unwrap().clone();
    *fixture.service_snapshot.lock().unwrap() =
        snapshot.replace("ActiveState=active", "ActiveState=inactive");
    let (sink, _) = stream_sink();
    assert!(service
        .execute_action(&profile.id, &plan.id, "".into(), sink)
        .await
        .is_err());
    assert!(fixture
        .commands
        .lock()
        .unwrap()
        .iter()
        .all(|command| !command.starts_with("sudo ")));
    let plan = service
        .review_action(&profile.id, action.clone())
        .await
        .unwrap();
    let second = service.review_action(&profile.id, action).await.unwrap();
    let (sink, mut output) = stream_sink();
    let id = service
        .execute_action(
            &profile.id,
            &plan.id,
            "fixture-sudo-password".into(),
            sink.clone(),
        )
        .await
        .unwrap();
    assert!(service
        .execute_action(&profile.id, &second.id, "".into(), sink)
        .await
        .is_err());
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { .. }
    ));
    service.close_stream(&profile.id, &id).await.unwrap();
}
#[tokio::test]
async fn protected_service_changes_fail_before_any_remote_command() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    for name in [
        "ssh.service",
        "sshd.service",
        "docker.service",
        "nginx.service",
        "systemd-networkd.service",
    ] {
        assert!(service
            .review_action(
                &profile.id,
                actions::AppAction::ServiceChange {
                    unit: name.into(),
                    operation: services::ServiceOperation::Stop
                }
            )
            .await
            .is_err());
    }
    assert!(fixture.commands.lock().unwrap().is_empty());
}
#[test]
#[ignore = "Requires the explicitly created rootless disposable systemd fixture; see tests/fixtures/README.md"]
fn disposable_systemd_container_supports_service_lifecycle_and_verification() {
    let container = std::env::var("VPS_PILOT_CONTAINER_FIXTURE")
        .expect("Set the disposable fixture container name");
    assert!(container.starts_with("vps-pilot-fixture-"));
    let label = std::process::Command::new("podman")
        .args([
            "inspect",
            "--format",
            "{{ index .Config.Labels \"org.vps-pilot.fixture\" }}",
            &container,
        ])
        .output()
        .unwrap();
    assert!(label.status.success());
    assert!(String::from_utf8_lossy(&label.stdout).trim() == "true");
    let execute = |command: &str| {
        let output = std::process::Command::new("podman")
            .args(["exec", &container, "sh", "-c", command])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Disposable systemd fixture command failed"
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let unit = "vps-pilot-fixture.service";
    let snapshot = execute(&services::probe(unit));
    services::validate(&snapshot, unit, services::ServiceOperation::Start).unwrap();
    for operation in [
        services::ServiceOperation::Start,
        services::ServiceOperation::Restart,
        services::ServiceOperation::Stop,
        services::ServiceOperation::Enable,
        services::ServiceOperation::Disable,
    ] {
        execute(&format!(
            "sudo -S -p '[VPS Pilot sudo password] ' -- /usr/bin/systemctl {} -- '{}' && {}",
            operation.verb(),
            unit,
            operation.verify(unit)
        ));
    }
}

#[tokio::test]
#[ignore = "Run tests/fixtures/run-ssh.sh to create a disposable loopback-only OpenSSH fixture"]
async fn disposable_openssh_runs_real_pty_and_reports_partial_inspections() {
    let port: u16 = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let key = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_IDENTITY").unwrap();
    let fingerprint = std::env::var("VPS_PILOT_OPENSSH_FIXTURE_FINGERPRINT").unwrap();
    let (_dir, service) = service();
    let mut input = input(port);
    input.username = "root".into();
    input.password_allowed = false;
    input.identity_file = Some(key);
    let profile = service.save_profile(input).await.unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    assert!(inspection.observed.fingerprint == fingerprint);
    service
        .trust(&profile.id, &inspection.challenge_id)
        .await
        .unwrap();
    service
        .connect(&profile.id, &inspection.challenge_id, "".into())
        .await
        .unwrap();
    let connection_id = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    assert!(service
        .configuration_snapshot(&profile.id, "stale-generation")
        .await
        .is_err());
    let probe_started = Instant::now();
    let snapshot = service
        .configuration_snapshot(&profile.id, &connection_id)
        .await
        .unwrap();
    eprintln!(
        "Disposable configuration probe elapsed: {:?}",
        probe_started.elapsed()
    );
    let projected = serde_json::to_value(&snapshot).unwrap();
    let snapshot_id = projected["snapshotId"].as_str().unwrap().to_string();
    assert_eq!(projected["profileId"], profile.id);
    assert_eq!(projected["connectionId"], connection_id);
    let sections = projected["sections"].as_array().unwrap();
    assert_eq!(sections.len(), 8);
    let system = sections.iter().find(|item| item["id"] == "system").unwrap();
    assert!(system["values"]["Operating system"]
        .as_str()
        .unwrap()
        .contains("Debian"));
    let ssh = sections.iter().find(|item| item["id"] == "ssh").unwrap();
    assert_eq!(ssh["state"], "partial");
    assert_eq!(
        ssh["values"]["Key authentication"],
        "Not independently verified"
    );
    let public_text =
        std::fs::read_to_string(format!("{}.pub", profile.identity_file.as_ref().unwrap()))
            .unwrap();
    let public = russh::keys::PublicKey::from_openssh(&public_text).unwrap();
    let expected_fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
    assert!(ssh["values"]
        .as_object()
        .unwrap()
        .iter()
        .any(|(name, value)| name.starts_with("Authorized key ")
            && value
                .as_str()
                .is_some_and(|text| text.contains(&expected_fingerprint))));
    assert!(!ssh
        .to_string()
        .contains(public_text.split_whitespace().nth(1).unwrap()));
    let review = service
        .configuration_review(
            &profile.id,
            &connection_id,
            &snapshot_id,
            vec!["ssh".into(), "essentials".into()],
        )
        .await
        .unwrap();
    let review_json = serde_json::to_value(&review).unwrap();
    let review_id = review_json["id"].as_str().unwrap().to_string();
    let review_expires_at = review_json["expiresAt"].as_u64().unwrap();
    assert_eq!(review_json["canExecute"], false);
    assert_eq!(review_json["snapshotId"], snapshot_id);
    assert_eq!(review_json["profileId"], profile.id);
    assert_eq!(review_json["connectionId"], connection_id);
    let review_items = review_json["items"].as_array().unwrap();
    let ssh_item = review_items
        .iter()
        .find(|item| item["id"] == "ssh")
        .unwrap();
    assert_eq!(ssh_item["evidenceState"], "partial");
    assert_eq!(ssh_item["blockers"].as_array().unwrap().len(), 2);
    let recheck = service
        .configuration_review_validate(&profile.id, &connection_id, &review_id)
        .await
        .unwrap();
    let recheck_json = serde_json::to_value(&recheck).unwrap();
    assert_eq!(recheck_json["id"], review_id);
    assert_eq!(
        recheck_json["expiresAt"].as_u64().unwrap(),
        review_expires_at
    );
    assert!(service
        .configuration_review(
            &profile.id,
            "forged-generation",
            &snapshot_id,
            vec!["system".into()],
        )
        .await
        .is_err());
    assert!(service
        .configuration_review(
            &profile.id,
            &connection_id,
            &uuid::Uuid::new_v4().to_string(),
            vec!["system".into()],
        )
        .await
        .is_err());
    let (sink, mut output) = stream_sink();
    let id = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    let mut text = String::new();
    service
        .control(
            &profile.id,
            &id,
            streams::Control::Input(b"printf 'VPS_PILOT_%s\\n' REAL_PTY_OK\n".to_vec()),
        )
        .await
        .unwrap();
    loop {
        match event(&mut output).await {
            streams::StreamEvent::Metrics { .. } => unreachable!("not a monitoring stream"),
            streams::StreamEvent::Inspection { .. } => unreachable!("event helper filters reports"),
            streams::StreamEvent::Data { data, sequence, .. } => {
                text.push_str(&String::from_utf8_lossy(&data));
                service
                    .control(&profile.id, &id, streams::Control::Ack(sequence))
                    .await
                    .unwrap();
                if text.contains("VPS_PILOT_REAL_PTY_OK") {
                    break;
                }
            }
            _ => panic!("Real OpenSSH fixture ended before returning shell output"),
        }
    }
    service.close_stream(&profile.id, &id).await.unwrap();
    let (sink, mut output) = stream_sink();
    let command = discovery::InspectionKind::Overview.command();
    let id = service
        .start_stream(&profile.id, None, Some(&command), sink)
        .await
        .unwrap();
    let mut text = String::new();
    loop {
        match event(&mut output).await {
            streams::StreamEvent::Metrics { .. } => unreachable!("not a monitoring stream"),
            streams::StreamEvent::Inspection { .. } => unreachable!("event helper filters reports"),
            streams::StreamEvent::Data { data, sequence, .. } => {
                text.push_str(&String::from_utf8_lossy(&data));
                service
                    .control(&profile.id, &id, streams::Control::Ack(sequence))
                    .await
                    .unwrap();
            }
            streams::StreamEvent::Closed { code, .. } => {
                assert_eq!(code, Some(1));
                break;
            }
        }
    }
    assert!(text.contains("Debian GNU/Linux 12"));
    assert!(text.contains("=== CPU counters ==="));
    assert!(text.contains("[section failed: exit"));
    let report = structured::parse(
        &text,
        structured::Format::Inspection(discovery::InspectionKind::Overview),
        Some(1),
    );
    assert!(report
        .overview
        .as_ref()
        .unwrap()
        .memory_total
        .is_some_and(|bytes| bytes > 0));
    assert!(report
        .sections
        .iter()
        .any(|section| section.title == "Filesystems" && !section.rows.is_empty()));
    assert!(report
        .sections
        .iter()
        .any(|section| section.title == "Failed services" && section.state == "unavailable"));
    let (sink, mut output) = stream_sink();
    let id = service.start_monitor(&profile.id, 1, sink).await.unwrap();
    let mut previous_uptime = None;
    let mut first_uptime = None;
    for _ in 0..64 {
        match event(&mut output).await {
            streams::StreamEvent::Metrics {
                sample, sequence, ..
            } => {
                assert!(sample.memory_total > 0 && sample.cpu_total >= sample.cpu_idle);
                if let Some(previous) = previous_uptime {
                    assert!(sample.uptime > previous);
                }
                first_uptime.get_or_insert(sample.uptime);
                previous_uptime = Some(sample.uptime);
                service
                    .control(&profile.id, &id, streams::Control::Ack(sequence))
                    .await
                    .unwrap();
            }
            _ => panic!("The real sampler must return typed metrics"),
        }
    }
    assert!(previous_uptime.unwrap() - first_uptime.unwrap() >= 60.0);
    service.close_stream(&profile.id, &id).await.unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Closed { .. }
    ));
    // This profile is the disposable, pinned, loopback-only fixture, never a real VPS.
    let runtime = service.runtime.lock().await;
    let remaining = services::collect(&runtime, &profile.id, "ps -C python3 -o pid= || :")
        .await
        .unwrap();
    assert!(
        remaining.trim().is_empty(),
        "Sampler must exit on SSH input EOF"
    );
    drop(runtime);
    service.disconnect(&profile.id).await.unwrap();
}

#[tokio::test]
async fn production_default_blocks_mutations_in_rust_before_network_work() {
    let dir = tempfile::tempdir().unwrap();
    let service = SshService::new(dir.path().join("profiles.json"));
    assert!(!service.changes_enabled);
    let error = service
        .review_action(
            "not-a-server",
            actions::AppAction::ServiceChange {
                unit: "app.service".into(),
                operation: services::ServiceOperation::Restart,
            },
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("read-only"));
    assert!(service.runtime.lock().await.approvals.is_empty());
}

#[cfg(unix)]
fn setup_vault(dir: &tempfile::TempDir) -> crate::setup_keys::KeyVault {
    use std::os::unix::fs::PermissionsExt;
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    crate::setup_keys::KeyVault::new(dir.path().join("legacy-keys"), home.join(".ssh"))
}

#[cfg(unix)]
fn setup_public_key(key: &crate::setup_keys::SetupKey) -> keys::PublicKey {
    let text = std::fs::read_to_string(format!("{}.pub", key.path)).unwrap();
    keys::PublicKey::from_openssh(&text).unwrap()
}

#[cfg(unix)]
fn verify_request(
    profile: &Profile,
    connection_id: &str,
    key_id: &str,
    username: &str,
    port: u16,
    passphrase: &str,
) -> setup_access::VerifyRequest {
    setup_access::VerifyRequest {
        profile_id: profile.id.clone(),
        connection_id: connection_id.into(),
        profile_revision: profile.revision.clone(),
        key_id: key_id.into(),
        username: username.into(),
        port,
        passphrase: Some(passphrase.into()),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_proves_the_selected_key_and_keeps_the_source_session_alive() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fixture = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(host_key),
    )
    .await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready"
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();
    let auth_before = fixture.auth_count.load(Ordering::SeqCst);
    let opens_before = fixture.channel_opens.load(Ordering::SeqCst);
    let proof = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "deploy",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap();
    assert_eq!(proof.profile_id, profile.id);
    assert_eq!(proof.connection_id, connection);
    assert_eq!(proof.key_id, key.key_id);
    assert_eq!(proof.key_fingerprint, key.fingerprint);
    assert_eq!(proof.key_location, crate::setup_keys::KeyLocation::Ssh);
    assert_eq!(proof.username, "deploy");
    assert_eq!(proof.host, "127.0.0.1");
    assert_eq!(proof.port, fixture.port);
    assert!(proof.expires_at_ms > 0);
    // Only the selected public-key attempt reached the server. No password,
    // none, agent or default-key fallback ran, and no channel was opened.
    assert_eq!(fixture.auth_count.load(Ordering::SeqCst), auth_before + 1);
    assert_eq!(fixture.channel_opens.load(Ordering::SeqCst), opens_before);
    assert!(fixture.commands.lock().unwrap().is_empty());
    // The original password connection and its PTY remain usable.
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"source-still-alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"source-still-alive"
    ));
    let checked = service
        .valid_setup_proof_record(&vault, &proof.proof_id)
        .await
        .unwrap();
    assert_eq!(checked.id, proof.proof_id);
    service.setup_access.expire_for_test(&proof.proof_id);
    assert!(service
        .valid_setup_proof_record(&vault, &proof.proof_id)
        .await
        .is_err());
    // A later source disconnect invalidates an otherwise unexpired proof.
    let second = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "deploy",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap();
    assert!(service
        .valid_setup_proof_record(&vault, &second.proof_id)
        .await
        .is_ok());
    service.disconnect(&profile.id).await.unwrap();
    let error = match service
        .valid_setup_proof_record(&vault, &second.proof_id)
        .await
    {
        Ok(_) => panic!("a disconnected proof must not revalidate"),
        Err(error) => error,
    };
    assert!(
        error.contains("connection") || error.contains("Connect"),
        "{error}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_verifies_a_second_target_port_and_account_with_the_same_host_identity() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let source =
        Fixture::start_with_target_key(0, None, None, false, None, None, Some(host_key.clone()))
            .await;
    let target = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(host_key),
    )
    .await;
    assert_ne!(source.port, target.port);
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &source).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let source_auth = source.auth_count.load(Ordering::SeqCst);
    let proof = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "deploy",
                target.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap();
    assert_eq!(proof.port, target.port);
    assert_eq!(proof.username, "deploy");
    assert_eq!(target.auth_count.load(Ordering::SeqCst), 1);
    assert_eq!(source.auth_count.load(Ordering::SeqCst), source_auth);
    assert!(source.commands.lock().unwrap().is_empty());
    assert!(target.commands.lock().unwrap().is_empty());
    assert_eq!(service.statuses().await[0].status, "connected");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_rejects_wrong_key_and_passphrase_without_fallback() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let selected = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let other = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fixture = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&selected)),
        Some(host_key),
    )
    .await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let ops_before = fixture.channel_opens.load(Ordering::SeqCst);
    let auth_before = fixture.auth_count.load(Ordering::SeqCst);
    let error = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &other.key_id,
                "deploy",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap_err();
    assert!(
        error.contains("did not accept") || error.contains("authentication failed"),
        "{error}"
    );
    assert_eq!(fixture.auth_count.load(Ordering::SeqCst), auth_before + 1);
    let auth_after_key = fixture.auth_count.load(Ordering::SeqCst);
    let error = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &selected.key_id,
                "deploy",
                fixture.port,
                "wrong-fixture-passphrase",
            ),
        )
        .await
        .unwrap_err();
    assert!(
        error.contains("passphrase") || error.contains("unlock"),
        "{error}"
    );
    assert_eq!(
        fixture.auth_count.load(Ordering::SeqCst),
        auth_after_key,
        "an unlock failure must not reach the server"
    );
    assert_eq!(fixture.channel_opens.load(Ordering::SeqCst), ops_before);
    assert!(fixture.commands.lock().unwrap().is_empty());
    assert_eq!(service.statuses().await[0].status, "connected");
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_rejects_a_changed_host_identity_without_authenticating() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let source_host = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let target_host = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let source =
        Fixture::start_with_target_key(0, None, None, false, None, None, Some(source_host)).await;
    let target = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(target_host),
    )
    .await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &source).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let error = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "deploy",
                target.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap_err();
    assert!(
        error.contains("host identity") || error.contains("verified SSH connection"),
        "{error}"
    );
    assert_eq!(target.auth_count.load(Ordering::SeqCst), 0);
    assert_eq!(service.statuses().await[0].status, "connected");
    assert!(source.commands.lock().unwrap().is_empty());
    assert!(target.commands.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_proof_fails_after_the_selected_key_is_tampered() {
    use std::os::unix::fs::PermissionsExt;
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fixture = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(host_key),
    )
    .await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let proof = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "deploy",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap();
    let original = std::fs::read(&key.path).unwrap();
    std::fs::write(&key.path, b"tampered fixture key").unwrap();
    std::fs::set_permissions(&key.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(service
        .valid_setup_proof_record(&vault, &proof.proof_id)
        .await
        .is_err());
    std::fs::write(&key.path, original).unwrap();
    std::fs::set_permissions(&key.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(service
        .valid_setup_proof_record(&vault, &proof.proof_id)
        .await
        .is_ok());
}

#[tokio::test]
async fn live_monitor_is_singleton_server_bound_and_waits_for_ack() {
    let fixture = Fixture::start(0, None).await;
    let (_dir, mut service) = service();
    service.changes_enabled = false;
    let profile = fixture_connection(&service, &fixture).await;
    let (sink, mut output) = stream_sink();
    assert!(service
        .start_monitor(&profile.id, 0, sink.clone())
        .await
        .is_err());
    let id = service
        .start_monitor(&profile.id, 1, sink.clone())
        .await
        .unwrap();
    assert!(service.start_monitor(&profile.id, 1, sink).await.is_err());
    assert!(service.close_stream("different-server", &id).await.is_err());
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Metrics { sequence: 1, .. }
    ));
    service
        .control(
            &profile.id,
            &id,
            streams::Control::Input(b"must-not-reach-sampler".to_vec()),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(fixture.monitor_requests.load(Ordering::SeqCst), 1);
    assert!(output.try_recv().is_err());
    service
        .control(&profile.id, &id, streams::Control::Ack(1))
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Metrics { sequence: 2, .. }
    ));
    service.close_stream(&profile.id, &id).await.unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Closed { .. }
    ));
    let (sink, mut output) = stream_sink();
    let id = service.start_monitor(&profile.id, 5, sink).await.unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Metrics { .. }
    ));
    service.disconnect(&profile.id).await.unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Closed { .. }
    ));
    assert!(!service.runtime.lock().await.streams.contains_key(&id));
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_does_not_account_foreign_or_malformed_profiles() {
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault
        .generate_async("fixture-key-passphrase".into())
        .await
        .unwrap();
    let (_dir, service) = service();
    for index in 0..150 {
        let profile_id = if index % 2 == 0 {
            format!("foreign-profile-{index}")
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let request = setup_access::VerifyRequest {
            profile_id,
            connection_id: "connection".into(),
            profile_revision: uuid::Uuid::new_v4().to_string(),
            key_id: key.key_id.clone(),
            username: "deploy".into(),
            port: 22,
            passphrase: Some("fixture-key-passphrase".into()),
        };
        assert!(service
            .verify_setup_key_login(&vault, request)
            .await
            .is_err());
    }
    assert_eq!(service.setup_access.failure_entries_for_test(), 0);
    assert_eq!(service.setup_access.attempt_entries_for_test(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn setup_key_login_failure_cache_is_bounded() {
    let (_dir, service) = service();
    for index in 0..150 {
        service
            .setup_access
            .record_failure_for_test(&format!("profile-{index}"));
    }
    assert!(service.setup_access.failure_entries_for_test() <= 100);
}

#[cfg(unix)]
struct ConfigExportFixture {
    _service_dir: tempfile::TempDir,
    _key_dir: tempfile::TempDir,
    vault: crate::setup_keys::KeyVault,
    service: SshService,
    _fixture: Fixture,
    profile: Profile,
    key: crate::setup_keys::SetupKey,
    proof: setup_access::KeyLoginProof,
}

#[cfg(unix)]
async fn config_export_fixture(config_text: Option<&str>) -> ConfigExportFixture {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    if let Some(text) = config_text {
        use std::os::unix::fs::PermissionsExt;
        let path = vault.standard_ssh_root().join("config");
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fixture = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(host_key),
    )
    .await;
    let service_dir = tempfile::tempdir().unwrap();
    let service = SshService::new(service_dir.path().join("profiles.json"));
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let proof = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "deploy",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap();
    ConfigExportFixture {
        _service_dir: service_dir,
        _key_dir: key_dir,
        vault,
        service,
        _fixture: fixture,
        profile,
        key,
        proof,
    }
}

#[cfg(unix)]
async fn review_config(
    fixture: &ConfigExportFixture,
    alias: &str,
) -> Result<setup_access::SetupConfigReview, String> {
    fixture
        .service
        .review_setup_config(&fixture.vault, &fixture.proof.proof_id, alias)
        .await
}

#[cfg(unix)]
async fn save_config(
    fixture: &ConfigExportFixture,
    review_id: &str,
) -> Result<setup_access::SetupConfigSave, String> {
    fixture
        .service
        .save_setup_config(&fixture.vault, review_id)
        .await
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_save_preserves_unrelated_bytes_and_keeps_a_protected_backup() {
    use std::os::unix::fs::PermissionsExt;
    const ORIGINAL: &str = "# keep this comment\nHost *\n    ServerAliveInterval 30\nHost other\n    HostName other.example.com\n    User ops\n";
    let fixture = config_export_fixture(Some(ORIGINAL)).await;
    let review = review_config(&fixture, "fixture-alias").await.unwrap();
    assert_eq!(review.mode, "create");
    assert!(review.backup);
    assert_eq!(review.destination, "~/.ssh/config");
    assert_eq!(review.key_fingerprint, fixture.key.fingerprint);
    assert_eq!(review.username, "deploy");
    assert_eq!(review.host, "127.0.0.1");
    assert_eq!(review.port, fixture._fixture.port);
    assert!(review
        .entry
        .starts_with(&format!("# vps-pilot:begin {}", fixture.profile.id)));
    assert!(review.entry.contains("\nHost *\n# vps-pilot:end "));
    assert!(!review.entry.contains("keep this comment"));
    let config_path = fixture.vault.standard_ssh_root().join("config");
    let saved = save_config(&fixture, &review.review_id).await.unwrap();
    assert_eq!(saved.status, "saved");
    assert_eq!(saved.alias, "fixture-alias");
    assert_eq!(saved.destination, "~/.ssh/config");
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert!(text.starts_with(review.entry.as_str()));
    assert_eq!(&text[review.entry.len()..], ORIGINAL);
    assert_eq!(
        std::fs::metadata(&config_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!fixture
        .vault
        .standard_ssh_root()
        .join("known_hosts")
        .exists());
    let backup = saved
        .backup_path
        .expect("existing config must be backed up");
    assert_eq!(std::fs::read(&backup).unwrap(), ORIGINAL.as_bytes());
    assert_eq!(
        std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // A matching same-content review is a no-op and writes nothing.
    let again = review_config(&fixture, "fixture-alias").await.unwrap();
    assert_eq!(again.mode, "noChange");
    assert!(!again.backup);
    let before = std::fs::read(&config_path).unwrap();
    let saved_again = save_config(&fixture, &again.review_id).await.unwrap();
    assert!(saved_again.backup_path.is_none());
    assert_eq!(std::fs::read(&config_path).unwrap(), before);
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_update_replaces_only_the_owned_block_with_a_fresh_backup() {
    use std::os::unix::fs::PermissionsExt;
    const ORIGINAL: &str = "# keep\nHost *\n    ServerAliveInterval 30\nHost other\n    HostName other.example.com\n    User ops\n";
    let fixture = config_export_fixture(Some(ORIGINAL)).await;
    let first = review_config(&fixture, "first-alias").await.unwrap();
    let first_entry = first.entry.clone();
    save_config(&fixture, &first.review_id).await.unwrap();
    let config_path = fixture.vault.standard_ssh_root().join("config");
    let after_first = std::fs::read(&config_path).unwrap();
    let second = review_config(&fixture, "second-alias").await.unwrap();
    assert_eq!(second.mode, "update");
    assert!(second.backup);
    assert!(second.entry.contains("Host second-alias"));
    assert!(!second.entry.contains("Host first-alias"));
    let saved = save_config(&fixture, &second.review_id).await.unwrap();
    let backup = saved.backup_path.unwrap();
    assert_eq!(std::fs::read(&backup).unwrap(), after_first);
    assert_eq!(
        std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert!(text.starts_with(second.entry.as_str()));
    assert_eq!(&text[second.entry.len()..], ORIGINAL);
    assert!(!text.contains(&first_entry));
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_rejects_alias_collisions_and_injection_without_writing() {
    const ORIGINAL: &str = "Host taken\n    HostName taken.example.com\n";
    let fixture = config_export_fixture(Some(ORIGINAL)).await;
    let config_path = fixture.vault.standard_ssh_root().join("config");
    for alias in [
        "taken",
        "TAKEN",
        "bad alias",
        "-oProxyCommand=evil",
        "foo\nHost evil",
        "*",
        "!evil",
        "alias#comment",
        "alias;command",
    ] {
        assert!(review_config(&fixture, alias).await.is_err(), "{alias}");
    }
    let long = "a".repeat(65);
    assert!(review_config(&fixture, &long).await.is_err());
    assert_eq!(std::fs::read(&config_path).unwrap(), ORIGINAL.as_bytes());
    assert!(!fixture
        .vault
        .standard_ssh_root()
        .join(".vps-pilot-config.lock")
        .exists());
    assert_eq!(fixture.service.setup_access.review_entries_for_test(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_refuses_include_match_continuations_and_malformed_markers() {
    let profile_a = uuid::Uuid::new_v4().to_string();
    let profile_b = uuid::Uuid::new_v4().to_string();
    let texts = vec![
        "Include config.d/*\nHost *\n    User root\n".to_string(),
        "Include=config.d/*\nHost *\n    User root\n".to_string(),
        "Match exec touch /tmp/vps-pilot-must-not-run\nHost *\n    User root\n".to_string(),
        "Match=exec touch /tmp/vps-pilot-must-not-run\nHost *\n    User root\n".to_string(),
        "IgnoreUnknown *\nHost *\n    User root\n".to_string(),
        "IgnoreUnknown=*\nHost *\n    User root\n".to_string(),
        "Host *\n    ProxyCommand fixture \\\n        argument\n".to_string(),
        "Host=taken\n    HostName taken.example.com\n".to_string(),
        "Host = taken\n    HostName taken.example.com\n".to_string(),
        "Host \"quoted\"\n    HostName quoted.example.com\n".to_string(),
        "Host taken#reinterpreted\n    HostName taken.example.com\n".to_string(),
        "Host taken,other\n    HostName taken.example.com\n".to_string(),
        format!("# vps-pilot:begin {profile_a}\nHost orphan\n"),
        format!(
            "  # vps-pilot:begin {profile_a}\nHost indented\n  # vps-pilot:end {profile_a}\n"
        ),
        format!(
            "# vps-pilot:begin {profile_a}\n# vps-pilot:begin {profile_b}\nHost nested\n# vps-pilot:end {profile_b}\n# vps-pilot:end {profile_a}\n"
        ),
        format!(
            "# vps-pilot:begin {profile_a}\nHost one\n# vps-pilot:end {profile_a}\n# vps-pilot:begin {profile_a}\nHost two\n# vps-pilot:end {profile_a}\n"
        ),
        "# vps-pilot:begin not-a-uuid\nHost bad\n# vps-pilot:end not-a-uuid\n".to_string(),
    ];
    for text in texts {
        let fixture = config_export_fixture(Some(&text)).await;
        assert!(
            review_config(&fixture, "safe-alias").await.is_err(),
            "{text}"
        );
        assert_eq!(
            std::fs::read(fixture.vault.standard_ssh_root().join("config")).unwrap(),
            text.as_bytes()
        );
        assert_eq!(fixture.service.setup_access.review_entries_for_test(), 0);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_collision_checks_include_other_managed_blocks() {
    let other_profile = uuid::Uuid::new_v4().to_string();
    let other_key = uuid::Uuid::new_v4().to_string();
    let text = format!(
        "# vps-pilot:begin {other_profile}\nHost taken\n    HostName taken.example.com\n    User ops\n    Port 22\n    IdentityFile ~/.ssh/vps-pilot_{other_key}\n    IdentitiesOnly yes\n    PreferredAuthentications publickey\nHost *\n# vps-pilot:end {other_profile}\n"
    );
    let fixture = config_export_fixture(Some(&text)).await;
    let error = review_config(&fixture, "taken").await.unwrap_err();
    assert!(error.contains("alias"), "{error}");
    assert_eq!(
        std::fs::read(fixture.vault.standard_ssh_root().join("config")).unwrap(),
        text.as_bytes()
    );
    assert_eq!(fixture.service.setup_access.review_entries_for_test(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_never_reads_include_targets() {
    let fixture = config_export_fixture(Some("Include config.d/*\nHost *\n    User root\n")).await;
    let include_dir = fixture.vault.standard_ssh_root().join("config.d");
    std::fs::create_dir(&include_dir).unwrap();
    let included = include_dir.join("evil");
    std::fs::write(&included, "Host included\n").unwrap();
    let error = review_config(&fixture, "safe-alias").await.unwrap_err();
    assert!(error.contains("Include"), "{error}");
    assert_eq!(
        std::fs::read_to_string(&included).unwrap(),
        "Host included\n"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_rejects_unsafe_paths_and_permissions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let fixture = config_export_fixture(None).await;
    let root = fixture.vault.standard_ssh_root().to_path_buf();

    let outside = fixture._key_dir.path().join("outside-config");
    std::fs::write(&outside, "Host outside\n").unwrap();
    symlink(&outside, root.join("config")).unwrap();
    assert!(review_config(&fixture, "safe-alias").await.is_err());
    std::fs::remove_file(root.join("config")).unwrap();

    std::fs::write(root.join("config"), "Host linked\n").unwrap();
    std::fs::set_permissions(root.join("config"), std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::hard_link(
        root.join("config"),
        fixture._key_dir.path().join("hardlink"),
    )
    .unwrap();
    assert!(review_config(&fixture, "safe-alias").await.is_err());
    std::fs::remove_file(root.join("config")).unwrap();

    let path = root.join("config");
    std::fs::write(&path, "Host insecure\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(review_config(&fixture, "safe-alias").await.is_err());
    std::fs::remove_file(&path).unwrap();

    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o775)).unwrap();
    assert!(review_config(&fixture, "safe-alias").await.is_err());
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(fixture.service.setup_access.review_entries_for_test(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_save_fails_for_stale_expired_replayed_or_rejected_reviews() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = config_export_fixture(None).await;
    let review = review_config(&fixture, "stale-alias").await.unwrap();
    assert_eq!(review.mode, "create");
    let path = fixture.vault.standard_ssh_root().join("config");
    std::fs::write(&path, "Host external\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let error = save_config(&fixture, &review.review_id).await.unwrap_err();
    assert!(error.contains("changed"), "{error}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "Host external\n");

    let fixture2 = config_export_fixture(None).await;
    let expired = review_config(&fixture2, "expired-alias").await.unwrap();
    fixture2
        .service
        .setup_access
        .expire_review_for_test(&expired.review_id);
    assert!(save_config(&fixture2, &expired.review_id).await.is_err());
    let path2 = fixture2.vault.standard_ssh_root().join("config");
    assert!(!path2.exists());

    let fixture3 = config_export_fixture(None).await;
    let replay = review_config(&fixture3, "replay-alias").await.unwrap();
    save_config(&fixture3, &replay.review_id).await.unwrap();
    let path3 = fixture3.vault.standard_ssh_root().join("config");
    let after_save = std::fs::read(&path3).unwrap();
    assert!(save_config(&fixture3, &replay.review_id).await.is_err());
    assert_eq!(std::fs::read(&path3).unwrap(), after_save);

    let fixture4 = config_export_fixture(None).await;
    let rejected = review_config(&fixture4, "rejected-alias").await.unwrap();
    fixture4
        .service
        .reject_setup_config(&rejected.review_id)
        .unwrap();
    assert!(save_config(&fixture4, &rejected.review_id).await.is_err());
    let path4 = fixture4.vault.standard_ssh_root().join("config");
    assert!(!path4.exists());
    assert!(!fixture4
        .vault
        .standard_ssh_root()
        .join(".vps-pilot-config.lock")
        .exists());
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_requires_a_matching_public_sidecar() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = config_export_fixture(None).await;
    let public_path = std::path::PathBuf::from(format!("{}.pub", fixture.key.path));
    let original = std::fs::read(&public_path).unwrap();
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    std::fs::write(&public_path, other.public_key().to_openssh().unwrap()).unwrap();
    std::fs::set_permissions(&public_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let error = review_config(&fixture, "sidecar-alias").await.unwrap_err();
    assert!(
        error.contains("public key") || error.contains("does not match"),
        "{error}"
    );
    assert!(!fixture.vault.standard_ssh_root().join("config").exists());

    std::fs::write(&public_path, &original).unwrap();
    std::fs::set_permissions(&public_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let review = review_config(&fixture, "sidecar-alias").await.unwrap();
    // Tamper after review: saving must revalidate the pair.
    std::fs::write(&public_path, other.public_key().to_openssh().unwrap()).unwrap();
    std::fs::set_permissions(&public_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(save_config(&fixture, &review.review_id).await.is_err());
    assert!(!fixture.vault.standard_ssh_root().join("config").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_save_keeps_the_original_password_session_alive() {
    let fixture = config_export_fixture(None).await;
    let (sink, mut output) = stream_sink();
    let shell = fixture
        .service
        .start_stream(&fixture.profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready"
    ));
    fixture
        .service
        .control(&fixture.profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();
    let review = review_config(&fixture, "live-alias").await.unwrap();
    save_config(&fixture, &review.review_id).await.unwrap();
    fixture
        .service
        .control(
            &fixture.profile.id,
            &shell,
            streams::Control::Input(b"config-save-alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"config-save-alive"
    ));
    assert!(fixture._fixture.commands.lock().unwrap().is_empty());
    fixture
        .service
        .close_stream(&fixture.profile.id, &shell)
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_config_reviews_are_bounded() {
    let fixture = config_export_fixture(None).await;
    for index in 0..105 {
        review_config(&fixture, &format!("bounded-alias-{index}"))
            .await
            .unwrap();
    }
    assert!(fixture.service.setup_access.review_entries_for_test() <= 100);
}

#[cfg(unix)]
#[tokio::test]
async fn named_plaintext_key_proves_login_and_saves_a_named_config_entry() {
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault
        .generate_named_async("loopback-named".into(), String::new())
        .await
        .unwrap();
    assert!(!key.encrypted);
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fixture = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(host_key),
    )
    .await;
    let (_service_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready"
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();
    let auth_before = fixture.auth_count.load(Ordering::SeqCst);
    let proof = service
        .verify_setup_key_login(
            &vault,
            setup_access::VerifyRequest {
                profile_id: profile.id.clone(),
                connection_id: connection,
                profile_revision: profile.revision.clone(),
                key_id: key.key_id.clone(),
                username: "deploy".into(),
                port: fixture.port,
                passphrase: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(proof.key_fingerprint, key.fingerprint);
    assert_eq!(fixture.auth_count.load(Ordering::SeqCst), auth_before + 1);
    assert!(fixture.commands.lock().unwrap().is_empty());
    let review = service
        .review_setup_config(&vault, &proof.proof_id, "named-plain")
        .await
        .unwrap();
    assert!(
        review
            .entry
            .contains("    IdentityFile ~/.ssh/loopback-named\n"),
        "{}",
        review.entry
    );
    let original = std::fs::read(&key.path).unwrap();
    let saved = service
        .save_setup_config(&vault, &review.review_id)
        .await
        .unwrap();
    assert_eq!(saved.status, "saved");
    let config = std::fs::read_to_string(vault.standard_ssh_root().join("config")).unwrap();
    assert!(config.contains("IdentityFile ~/.ssh/loopback-named"));
    assert_eq!(std::fs::read(&key.path).unwrap(), original);
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"named-source-alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"named-source-alive"
    ));
    assert!(fixture.commands.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn selected_external_space_key_proves_login_and_saves_a_quoted_config_entry() {
    use std::os::unix::fs::PermissionsExt;
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let external = key_dir.path().join("selected keys");
    std::fs::create_dir_all(&external).unwrap();
    let path = external.join("my chosen key");
    let private = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    std::fs::write(
        &path,
        private
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let public_path = external.join("my chosen key.pub");
    std::fs::write(
        &public_path,
        format!("{}\n", private.public_key().to_openssh().unwrap()),
    )
    .unwrap();
    std::fs::set_permissions(&public_path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let original = std::fs::read(&path).unwrap();
    let key = vault.register_selected_async(path.clone()).await.unwrap();
    assert_eq!(key.location, crate::setup_keys::KeyLocation::External);
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let fixture = Fixture::start_with_target_key(
        0,
        None,
        None,
        false,
        Some("deploy".into()),
        Some(setup_public_key(&key)),
        Some(host_key),
    )
    .await;
    let (_service_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready"
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();
    let auth_before = fixture.auth_count.load(Ordering::SeqCst);
    let proof = service
        .verify_setup_key_login(
            &vault,
            setup_access::VerifyRequest {
                profile_id: profile.id.clone(),
                connection_id: connection,
                profile_revision: profile.revision.clone(),
                key_id: key.key_id.clone(),
                username: "deploy".into(),
                port: fixture.port,
                passphrase: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(proof.key_fingerprint, key.fingerprint);
    assert_eq!(fixture.auth_count.load(Ordering::SeqCst), auth_before + 1);
    assert!(fixture.commands.lock().unwrap().is_empty());
    let key_path = std::fs::canonicalize(&path).unwrap();
    let review = service
        .review_setup_config(&vault, &proof.proof_id, "selected-space")
        .await
        .unwrap();
    let identity = format!("    IdentityFile \"{}\"\n", key_path.to_string_lossy());
    assert!(review.entry.contains(&identity), "{}", review.entry);
    let saved = service
        .save_setup_config(&vault, &review.review_id)
        .await
        .unwrap();
    assert_eq!(saved.status, "saved");
    let config = std::fs::read_to_string(vault.standard_ssh_root().join("config")).unwrap();
    assert!(config.contains(&identity));
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"selected-source-alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"selected-source-alive"
    ));
    assert!(fixture.commands.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn reviewed_public_key_install_enables_the_selected_key_and_keeps_the_source_pty_alive() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let home_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(
        home_dir.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    let home = home_dir.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::set_permissions(&home, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir(&ssh_dir).unwrap();
    std::fs::set_permissions(
        &ssh_dir,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    let original = format!(
        "# keep existing key\nssh-ed25519 {} existing\n",
        "B".repeat(43) + "="
    );
    std::fs::write(ssh_dir.join("authorized_keys"), original.as_bytes()).unwrap();
    std::fs::set_permissions(
        ssh_dir.join("authorized_keys"),
        std::os::unix::fs::PermissionsExt::from_mode(0o600),
    )
    .unwrap();
    let public_line = setup_public_key(&key).to_openssh().unwrap();
    let fixture = Fixture::start_for_install(
        0,
        "tester".into(),
        setup_public_key(&key),
        Some(host_key),
        home.clone(),
    )
    .await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready"
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();

    let request = || setup_access::InstallRequest {
        profile_id: profile.id.clone(),
        profile_revision: profile.revision.clone(),
        connection_id: connection.clone(),
        key_id: key.key_id.clone(),
        target_username: None,
    };
    let review = service
        .review_setup_key_install(&vault, request())
        .await
        .unwrap();
    assert_eq!(review.profile_id, profile.id);
    assert_eq!(review.profile_revision, profile.revision);
    assert_eq!(review.connection_id, connection);
    assert_eq!(review.key_id, key.key_id);
    assert_eq!(review.key_fingerprint, key.fingerprint);
    assert_eq!(review.username, "tester");
    assert_eq!(review.host, "127.0.0.1");
    assert_eq!(review.port, fixture.port);
    assert_eq!(
        review.destination,
        home.join(".ssh/authorized_keys").to_string_lossy()
    );
    assert!(!review.already_present);
    assert!(review.backup_planned);
    assert!(review.expires_at_ms > 0);
    assert_eq!(review.command, setup_access::install_key::command());
    let projected = serde_json::to_string(&review).unwrap();
    assert!(!projected.contains("PRIVATE KEY"));
    assert!(!projected.contains(&key.path));
    assert!(!projected.contains(PASSPHRASE));

    // The fixture only accepts the selected key after the reviewed install.
    assert!(service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "tester",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .is_err());

    let result = service
        .apply_setup_key_install(&vault, &review.review_id)
        .await
        .unwrap();
    assert_eq!(result.status, "installed");
    assert_eq!(result.username, "tester");
    assert_eq!(result.port, fixture.port);
    let backup_path = PathBuf::from(result.backup_path.expect("existing file needs a backup"));
    assert!(backup_path.starts_with(home.join(".ssh")));
    assert_eq!(std::fs::read(&backup_path).unwrap(), original.as_bytes());
    assert_eq!(
        std::fs::metadata(&backup_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let installed = std::fs::read_to_string(home.join(".ssh/authorized_keys")).unwrap();
    assert!(installed.starts_with(original.as_str()));
    assert!(installed.contains(public_line.as_str()));

    // Only the selected public line crossed the IPC/command boundary; no
    // private key, passphrase or renderer-supplied path appears.
    let requests = fixture.install_requests.lock().unwrap().clone();
    assert!(requests
        .iter()
        .any(|request| String::from_utf8_lossy(request).contains(&public_line)));
    for request in &requests {
        let text = String::from_utf8_lossy(request);
        assert!(!text.contains(PASSPHRASE), "{text}");
        assert!(!text.contains("PRIVATE KEY"), "{text}");
        assert!(!text.contains(&key.path), "{text}");
    }

    let proof = service
        .verify_setup_key_login(
            &vault,
            verify_request(
                &profile,
                &connection,
                &key.key_id,
                "tester",
                fixture.port,
                PASSPHRASE,
            ),
        )
        .await
        .unwrap();
    assert_eq!(proof.key_fingerprint, key.fingerprint);
    assert_eq!(proof.username, "tester");

    // Single-use: a replay never executes another remote command.
    let commands = fixture.commands.lock().unwrap().len();
    assert!(service
        .apply_setup_key_install(&vault, &review.review_id)
        .await
        .is_err());
    assert_eq!(fixture.commands.lock().unwrap().len(), commands);

    // The original password-authenticated PTY remains usable.
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"install-source-alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"install-source-alive"
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn install_reviews_are_rejectable_expiring_and_bound_to_the_source_and_key() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let home_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(
        home_dir.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    let home = home_dir.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::set_permissions(&home, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    let fixture = Fixture::start_for_install(
        0,
        "tester".into(),
        setup_public_key(&key),
        Some(host_key),
        home,
    )
    .await;
    let (_dir, service) = service();
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let request = || setup_access::InstallRequest {
        profile_id: profile.id.clone(),
        profile_revision: profile.revision.clone(),
        connection_id: connection.clone(),
        key_id: key.key_id.clone(),
        target_username: None,
    };

    let rejected = service
        .review_setup_key_install(&vault, request())
        .await
        .unwrap();
    service
        .reject_setup_key_install(&rejected.review_id)
        .unwrap();
    assert!(service
        .apply_setup_key_install(&vault, &rejected.review_id)
        .await
        .is_err());

    let expired = service
        .review_setup_key_install(&vault, request())
        .await
        .unwrap();
    service
        .setup_access
        .install
        .expire_for_test(&expired.review_id);
    let error = service
        .apply_setup_key_install(&vault, &expired.review_id)
        .await
        .unwrap_err();
    assert!(error.contains("expired"), "{error}");

    let mut wrong_revision = request();
    wrong_revision.profile_revision = "not-the-current-revision".into();
    assert!(service
        .review_setup_key_install(&vault, wrong_revision)
        .await
        .is_err());
    let mut wrong_connection = request();
    wrong_connection.connection_id = "not-the-current-connection".into();
    assert!(service
        .review_setup_key_install(&vault, wrong_connection)
        .await
        .is_err());

    let changed = service
        .review_setup_key_install(&vault, request())
        .await
        .unwrap();
    // Replace the selected private key with unrelated bytes.
    std::fs::write(&key.path, b"not an OpenSSH private key").unwrap();
    let commands = fixture.commands.lock().unwrap().len();
    assert!(service
        .apply_setup_key_install(&vault, &changed.review_id)
        .await
        .is_err());
    assert_eq!(
        fixture.commands.lock().unwrap().len(),
        commands,
        "a changed key must be refused before any remote mutation"
    );
}

#[cfg(unix)]
fn root_input(port: u16) -> ProfileInput {
    ProfileInput {
        id: None,
        name: "Root fixture".into(),
        host: "127.0.0.1".into(),
        port,
        username: "root".into(),
        identity_file: None,
        password_allowed: true,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn staged_admin_flow_creates_target_installs_public_key_and_promotes_only_after_key_plus_sudo(
) {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let home_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home_dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    // The reviewed home path is /home/<username>; the fixture mirrors that shape
    // inside an owned temporary parent root.
    let home = std::fs::canonicalize(home_dir.path())
        .unwrap()
        .join("deploy");
    let fixture = Fixture::start_for_admin(
        0,
        "deploy".into(),
        setup_public_key(&key),
        Some(host_key),
        home.clone(),
    )
    .await;
    let (_dir, service) = service();
    let profile = service
        .save_profile(root_input(fixture.port))
        .await
        .unwrap();
    let inspection = service.inspect(&profile.id).await.unwrap();
    service
        .trust(&profile.id, &inspection.challenge_id)
        .await
        .unwrap();
    service
        .connect(
            &profile.id,
            &inspection.challenge_id,
            FIXTURE_PASSWORD.into(),
        )
        .await
        .unwrap();
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let (sink, mut output) = stream_sink();
    let shell = service
        .start_stream(&profile.id, Some((80, 24)), None, sink)
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"fixture shell ready"
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(1))
        .await
        .unwrap();

    // Choosing "existing" must not silently create, and vice versa.
    let review = service
        .review_setup_admin(
            &vault,
            setup_access::admin::AdminRequest {
                profile_id: profile.id.clone(),
                profile_revision: profile.revision.clone(),
                connection_id: connection.clone(),
                key_id: key.key_id.clone(),
                username: "deploy".into(),
                mode: "new".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(review.action, "create");
    assert_eq!(review.source_username, "root");
    assert_eq!(review.username, "deploy");
    assert!(!serde_json::to_string(&review)
        .unwrap()
        .contains(ADMIN_FIXTURE_PASSWORD));

    let mut wrong = setup_access::admin::AdminApplyRequest {
        review_id: review.review_id.clone(),
        password: ADMIN_FIXTURE_PASSWORD.into(),
    };
    wrong.review_id = "not-a-review".into();
    assert!(service.apply_setup_admin(&vault, wrong).await.is_err());

    // Create the account first, then install the key into its home (the
    // administrator-before-key ordering); key install must not be the primary
    // path for a different planned account.
    let created = service
        .apply_setup_admin(
            &vault,
            setup_access::admin::AdminApplyRequest {
                review_id: review.review_id.clone(),
                password: ADMIN_FIXTURE_PASSWORD.into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(created.status, "created");
    assert_eq!(created.username, "deploy");

    let expired = service
        .review_setup_admin(
            &vault,
            setup_access::admin::AdminRequest {
                profile_id: profile.id.clone(),
                profile_revision: profile.revision.clone(),
                connection_id: connection.clone(),
                key_id: key.key_id.clone(),
                username: "deploy".into(),
                mode: "existing".into(),
            },
        )
        .await
        .unwrap();
    service
        .setup_access
        .admin
        .expire_for_test(&expired.review_id);
    assert!(service
        .apply_setup_admin(
            &vault,
            setup_access::admin::AdminApplyRequest {
                review_id: expired.review_id,
                password: String::new(),
            }
        )
        .await
        .unwrap_err()
        .contains("expired"));

    let install = service
        .review_setup_key_install(
            &vault,
            setup_access::InstallRequest {
                profile_id: profile.id.clone(),
                profile_revision: profile.revision.clone(),
                connection_id: connection.clone(),
                key_id: key.key_id.clone(),
                target_username: Some("deploy".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(install.username, "deploy");
    assert!(install.command.contains("runuser -u deploy"));
    assert_eq!(
        install.destination,
        format!("{}/.ssh/authorized_keys", home.display())
    );
    let installed = service
        .apply_setup_key_install(&vault, &install.review_id)
        .await
        .unwrap();
    assert_eq!(installed.username, "deploy");
    assert_eq!(installed.status, "installed");
    let admin_home = home.join(".ssh/authorized_keys");
    assert!(std::fs::read_to_string(&admin_home)
        .unwrap()
        .contains(&setup_public_key(&key).to_openssh().unwrap()));

    // Source root profile and its PTY are still alive.
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"root-still-alive".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"root-still-alive"
    ));
    service
        .control(&profile.id, &shell, streams::Control::Ack(2))
        .await
        .unwrap();

    let proof = service
        .verify_setup_admin_access(
            &vault,
            setup_access::admin::AdminVerifyRequest {
                profile_id: profile.id.clone(),
                profile_revision: profile.revision.clone(),
                connection_id: connection.clone(),
                key_id: key.key_id.clone(),
                username: "deploy".into(),
                passphrase: Some(PASSPHRASE.into()),
                sudo_password: ADMIN_FIXTURE_PASSWORD.into(),
            },
        )
        .await
        .unwrap();
    assert!(proof.sudo_verified);
    assert_eq!(proof.source_username, "root");
    assert_eq!(proof.username, "deploy");
    assert!(!serde_json::to_string(&proof)
        .unwrap()
        .contains(ADMIN_FIXTURE_PASSWORD));

    let promoted = service
        .promote_setup_admin(&vault, &proof.proof_id)
        .await
        .unwrap();
    assert_eq!(promoted.previous_username, "root");
    assert_eq!(promoted.profile.username, "deploy");
    assert_eq!(promoted.profile.host, "127.0.0.1");
    assert_eq!(promoted.profile.port, fixture.port);
    assert_eq!(
        promoted.profile.identity_file.as_deref(),
        Some(key.path.as_str())
    );
    assert!(!promoted.profile.password_allowed);
    assert_ne!(promoted.profile.id, profile.id);

    // The promoted profile is live and independent; the original root session
    // and its own connection record are untouched.
    let statuses = service.statuses().await;
    let root_status = statuses
        .iter()
        .find(|s| s.profile_id == profile.id)
        .unwrap();
    assert_eq!(
        root_status.connection_id.as_deref(),
        Some(connection.as_str())
    );
    let admin_status = statuses
        .iter()
        .find(|s| s.profile_id == promoted.profile.id)
        .unwrap();
    assert_eq!(
        admin_status.connection_id.as_deref(),
        Some(promoted.connection_id.as_str())
    );
    service
        .control(
            &profile.id,
            &shell,
            streams::Control::Input(b"root-after-promote".to_vec()),
        )
        .await
        .unwrap();
    assert!(matches!(
        event(&mut output).await,
        streams::StreamEvent::Data { data, .. } if data == b"root-after-promote"
    ));

    // Single-use: a replayed proof cannot create a second profile.
    let count = service.profiles().unwrap().len();
    assert!(service
        .promote_setup_admin(&vault, &proof.proof_id)
        .await
        .is_err());
    assert_eq!(service.profiles().unwrap().len(), count);

    // No sudo password reached the persisted profile or admin request bytes.
    for request in fixture.admin_requests.lock().unwrap().iter() {
        let text = String::from_utf8_lossy(request);
        assert!(text.contains("deploy"), "{text}");
    }
    let stored = std::fs::read_to_string(_dir.path().join("profiles.json")).unwrap();
    assert!(!stored.contains(ADMIN_FIXTURE_PASSWORD));
    assert!(!stored.contains(PASSPHRASE));
}

#[cfg(unix)]
#[tokio::test]
async fn staged_admin_rejects_non_root_sources_and_wrong_existing_mode() {
    const PASSPHRASE: &str = "fixture-key-passphrase";
    let key_dir = tempfile::tempdir().unwrap();
    let vault = setup_vault(&key_dir);
    let key = vault.generate_async(PASSPHRASE.into()).await.unwrap();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let home_dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home_dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let home = std::fs::canonicalize(home_dir.path())
        .unwrap()
        .join("deploy");
    let fixture = Fixture::start_for_admin(
        0,
        "deploy".into(),
        setup_public_key(&key),
        Some(host_key),
        home,
    )
    .await;
    let (_dir, service) = service();
    // The ordinary fixture connection authenticates as `tester`, not root.
    let profile = fixture_connection(&service, &fixture).await;
    let connection = service
        .statuses()
        .await
        .into_iter()
        .find(|status| status.profile_id == profile.id)
        .unwrap()
        .connection_id
        .unwrap();
    let error = service
        .review_setup_admin(
            &vault,
            setup_access::admin::AdminRequest {
                profile_id: profile.id.clone(),
                profile_revision: profile.revision.clone(),
                connection_id: connection.clone(),
                key_id: key.key_id.clone(),
                username: "deploy".into(),
                mode: "new".into(),
            },
        )
        .await
        .unwrap_err();
    assert!(error.contains("root"), "{error}");
}
