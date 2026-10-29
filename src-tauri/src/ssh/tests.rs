use super::*;
use russh::{
    keys::{Algorithm, PrivateKey},
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
}
impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl server::Handler for TestServer {
    type Error = russh::Error;
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
}
impl Fixture {
    async fn start(port: u16, pause: Option<Arc<Notify>>) -> Self {
        let socket = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let auth_count = Arc::new(AtomicUsize::new(0));
        let mut server = TestServer {
            auth_count: auth_count.clone(),
            pause,
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
    }
}
fn service() -> (tempfile::TempDir, SshService) {
    let dir = tempfile::tempdir().unwrap();
    let service = SshService::new(dir.path().join("profiles.json"));
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
    assert!(!bytes.contains("password"));
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
    assert!(error.contains("No password was sent"));
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
