mod database;
mod ssh;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            let db = database::LocalDatabase::open(&config.join("vps-pilot.sqlite3"))
                .map_err(std::io::Error::other)?;
            app.manage(ssh::SshService::with_database(
                db.clone(),
                config.join("ssh-profiles.json"),
            ));
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::app_apply_zoom,
            database::app_bootstrap,
            database::app_save_settings,
            database::app_save_document,
            ssh::files::ssh_files_review_operation,
            ssh::files::ssh_files_execute_operation,
            ssh::files::ssh_files_reject_operation,
            ssh::files::ssh_files_cancel,
            ssh::files::ssh_files_size,
            ssh::files::ssh_files_list,
            ssh::files::ssh_file_read,
            ssh::files::ssh_file_review,
            ssh::files::ssh_file_commit,
            ssh::files::ssh_file_reject,
            ssh::files::ssh_file_upload,
            ssh::files::ssh_file_download,
            ssh::ssh_profiles,
            ssh::ssh_config_hosts,
            ssh::ssh_parse_command,
            ssh::ssh_save_profile,
            ssh::ssh_delete_profile,
            ssh::ssh_inspect,
            ssh::ssh_trust,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::monitor::ssh_monitor_start,
            ssh::monitor::ssh_monitor_describe,
            ssh::streams::ssh_terminal_open,
            ssh::docker::ssh_docker_query,
            ssh::docker::manager::ssh_docker_snapshot,
            ssh::docker::manager::ssh_docker_review,
            ssh::docker::manager::ssh_docker_execute,
            ssh::docker::manager::ssh_docker_reject,
            ssh::streams::ssh_terminal_input,
            ssh::streams::ssh_terminal_resize,
            ssh::streams::ssh_stream_ack,
            ssh::streams::ssh_stream_close,
            ssh::discovery::ssh_inspection_run,
            ssh::discovery::ssh_inspection_describe,
            ssh::actions::ssh_action_review,
            ssh::actions::ssh_action_execute,
            ssh::actions::ssh_action_reject,
            ssh::ssh_statuses
        ])
        .run(tauri::generate_context!())
        .expect("error while running VPS Pilot");
}
