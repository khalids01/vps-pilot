use super::*;
use russh::{
    keys::{self, Algorithm, PrivateKey},
    server::{self, Server as _},
};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Notify},
    task::JoinHandle,
};

const FIXTURE_PASSWORD: &str = "fixture-only-password";
#[derive(Clone)]
struct TestServer {
    auth_count: Arc<AtomicUsize>,
    pause: Option<Arc<Notify>>,
    accepted_key: Option<keys::PublicKey>,
    allow_none: bool,
    sudo_channels: std::collections::HashSet<russh::ChannelId>,
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
impl server::Handler for TestServer {
    type Error = russh::Error;
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
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
        if self.sudo_channels.remove(&channel) {
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
        Ok(
            if user == "tester" && self.accepted_key.as_ref() == Some(key.public_key) {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
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
        Ok(if user == "tester" && password == FIXTURE_PASSWORD {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
}
struct Fixture {
    port: u16,
    auth_count: Arc<AtomicUsize>,
    shutdown: server::RunningServerHandle,
    task: Option<JoinHandle<()>>,
    commands: Arc<Mutex<Vec<String>>>,
    sizes: Arc<Mutex<Vec<(u32, u32)>>>,
    sudo_inputs: Arc<AtomicUsize>,
    service_snapshot: Arc<Mutex<String>>,
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
        let socket = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let auth_count = Arc::new(AtomicUsize::new(0));
        let service_snapshot = Arc::new(Mutex::new("=== OS ===\nID=debian\nVERSION_ID=\"12\"\n=== Architecture ===\nx86_64\nId=app.service\nLoadState=loaded\nNeedDaemonReload=no\nType=simple\nDropInPaths=\nJob=\nRequiredBy=\nBoundBy=\nConsistsOf=\nFragmentPath=/etc/systemd/system/app.service\nRefuseManualStart=no\nRefuseManualStop=no\nActiveState=active\n=== Dependents ===\napp.service\n=== Unit file revision ===\n1:2:3:4:5\n".into()));
        let sudo_inputs = Arc::new(AtomicUsize::new(0));
        let commands = Arc::new(Mutex::new(Vec::new()));
        let sizes = Arc::new(Mutex::new(Vec::new()));
        let mut server = TestServer {
            sudo_channels: Default::default(),
            service_snapshot: service_snapshot.clone(),
            sudo_inputs: sudo_inputs.clone(),
            commands: commands.clone(),
            sizes: sizes.clone(),
            auth_count: auth_count.clone(),
            pause,
            accepted_key,
            allow_none,
        };
        let config = Arc::new(server::Config {
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            keys: vec![PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()],
            ..Default::default()
        });
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let running = server.run_on_socket(config, &socket);
            let _ = sender.send(running.handle());
            let _ = running.await;
        });
        Self {
            port,
            auth_count,
            shutdown: receiver.await.unwrap(),
            task: Some(task),
            commands,
            sizes,
            sudo_inputs,
            service_snapshot,
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
