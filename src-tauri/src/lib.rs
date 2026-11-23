mod database;
mod security;
mod setup_keys;
mod ssh;
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_biometry::init())
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
            let home = app.path().home_dir()?;
            app.manage(setup_keys::KeyVault::new(
                config.join("setup-keys"),
                home.join(".ssh"),
            ));
            app.manage(ssh::docker::database::DatabaseState::default());
            app.manage(ssh::setup_packages::PackageState::default());
            app.manage(security::Security::load(config.join("device-lock.json"))?);
            app.manage(db);
            Ok(())
        })
        .manage(ssh::pm2::Pm2State::default())
        .manage(ssh::proxy_workspace::ProxyWorkspaceState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                let security = window.state::<security::Security>();
                security.lock();
                if security.locked() {
                    let _ = window.emit("device-lock", ());
                }
            }
        })
        .invoke_handler(|invoke| {
            if !invoke
                .message
                .webview_ref()
                .state::<security::Security>()
                .allows(invoke.message.command())
            {
                invoke
                    .resolver
                    .reject("VPS Pilot is locked. Unlock with device authentication.");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                security::app_security_status,
                security::app_security_unlock,
                security::app_security_enable,
                security::app_security_change_password,
                security::app_security_lock,
                security::app_security_activity,
                security::ssh_password_forget,
                database::app_apply_zoom,
                database::app_bootstrap,
                database::app_save_settings,
                database::app_save_document,
                setup_keys::app_setup_keys_list,
                setup_keys::app_setup_key_generate,
                setup_keys::app_setup_key_check_name,
                setup_keys::app_setup_key_select,
                setup_keys::app_setup_key_use_ssh_directory,
                setup_keys::app_setup_key_export,
                ssh::files::ssh_files_review_operation,
                ssh::files::ssh_files_execute_operation,
                ssh::files::ssh_files_reject_operation,
                ssh::files::ssh_files_cancel,
                ssh::files::ssh_files_size,
                ssh::files::ssh_files_list,
                ssh::files::ssh_file_read,
                ssh::files::ssh_project_env_read,
                ssh::files::ssh_project_env_review,
                ssh::files::ssh_file_review,
                ssh::files::ssh_file_commit,
                ssh::files::ssh_file_reject,
                ssh::files::ssh_file_upload,
                ssh::files::ssh_file_download,
                ssh::configuration::ssh_configuration_snapshot,
                ssh::configuration::ssh_configuration_describe,
                ssh::configuration::ssh_configuration_cancel,
                ssh::configuration::ssh_configuration_review,
                ssh::configuration::ssh_configuration_review_validate,
                ssh::ssh_profiles,
                ssh::ssh_config_hosts,
                ssh::ssh_parse_command,
                ssh::pm2::ssh_pm2_status,
                ssh::proxy::ssh_proxy_detect,
                ssh::proxy_workspace::ssh_proxy_workspace_review,
                ssh::proxy_workspace::ssh_proxy_workspace_execute,
                ssh::proxy_workspace::ssh_proxy_workspace_reject,
                ssh::pm2::ssh_pm2_workflows_load,
                ssh::pm2::ssh_pm2_workflows_save,
                ssh::pm2::ssh_pm2_review,
                ssh::pm2::ssh_pm2_apply,
                ssh::ssh_save_profile,
                ssh::ssh_delete_profile,
                ssh::ssh_inspect,
                ssh::ssh_trust,
                ssh::ssh_connect,
                ssh::ssh_disconnect,
                ssh::setup_packages::ssh_setup_packages_command,
                ssh::setup_packages::ssh_setup_packages_scan,
                ssh::setup_packages::ssh_setup_packages_prepare,
                ssh::setup_packages::ssh_setup_packages_apply,
                ssh::setup_packages::ssh_setup_security_save,
                ssh::setup_access::ssh_setup_key_verify,
                ssh::setup_access::ssh_setup_config_review,
                ssh::setup_access::ssh_setup_config_save,
                ssh::setup_access::ssh_setup_config_reject,
                ssh::setup_access::ssh_setup_key_install_review,
                ssh::setup_access::ssh_setup_key_install_apply,
                ssh::setup_access::ssh_setup_key_install_reject,
                ssh::setup_access::admin_commands::ssh_setup_admin_review,
                ssh::setup_access::admin_commands::ssh_setup_admin_apply,
                ssh::setup_access::admin_commands::ssh_setup_admin_reject,
                ssh::setup_access::admin_commands::ssh_setup_admin_verify,
                ssh::setup_access::admin_commands::ssh_setup_admin_promote,
                ssh::connections::ssh_incoming_connections,
                ssh::monitor::ssh_monitor_start,
                ssh::monitor::ssh_monitor_describe,
                ssh::streams::ssh_terminal_open,
                ssh::docker::ssh_docker_query,
                ssh::docker::database::ssh_database_list,
                ssh::docker::database::ssh_database_backup,
                ssh::docker::database::ssh_database_cancel,
                ssh::docker::manager::ssh_docker_snapshot,
                ssh::docker::manager::ssh_docker_review,
                ssh::docker::manager::ssh_docker_execute,
                ssh::docker::manager::ssh_docker_reject,
                ssh::docker::manager::ssh_docker_cancel,
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
            ];
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .expect("error while running VPS Pilot");
}
