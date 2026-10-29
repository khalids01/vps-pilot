mod ssh;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(ssh::SshService::new(
                app.path().app_config_dir()?.join("ssh-profiles.json"),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_profiles,
            ssh::ssh_config_hosts,
            ssh::ssh_parse_command,
            ssh::ssh_save_profile,
            ssh::ssh_delete_profile,
            ssh::ssh_inspect,
            ssh::ssh_trust,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::streams::ssh_terminal_open,
            ssh::streams::ssh_terminal_input,
            ssh::streams::ssh_terminal_resize,
            ssh::streams::ssh_stream_ack,
            ssh::streams::ssh_stream_close,
            ssh::discovery::ssh_inspection_run,
            ssh::actions::ssh_action_review,
            ssh::actions::ssh_action_execute,
            ssh::actions::ssh_action_reject,
            ssh::ssh_statuses
        ])
        .run(tauri::generate_context!())
        .expect("error while running VPS Pilot");
}
