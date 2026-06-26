mod crypto;
mod db;
mod relay;
mod commands;

use commands::AppState;
use log::{info, error, warn};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();

    info!("BuddyLink v1.1.0 starting...");

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            info!("Setup phase started");

            // Use Tauri's app data directory for the database
            let app_data_dir = match app.path().app_data_dir() {
                Ok(path) => {
                    let p = path.to_string_lossy().to_string();
                    info!("App data dir resolved: {}", p);
                    p
                }
                Err(e) => {
                    error!("Failed to resolve app data directory: {}", e);
                    // Fallback to home directory
                    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                    let fallback = format!("{}/.buddylink", home);
                    warn!("Using fallback data dir: {}", fallback);
                    fallback
                }
            };

            // Ensure the directory exists
            if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
                error!("Failed to create app data directory '{}': {}", app_data_dir, e);
            }

            let db_path = format!("{}/buddylink.db", app_data_dir);
            let server_url = "wss://buddylink-relay-2.onrender.com";

            info!("Database path: {}", db_path);

            let app_state = match AppState::new(&db_path, server_url) {
                Ok(state) => {
                    info!("App state initialized successfully");
                    state
                }
                Err(e) => {
                    error!("Failed to initialize app state: {}", e);
                    let fallback_db = "/tmp/buddylink_fallback.db";
                    warn!("Attempting fallback database at: {}", fallback_db);
                    AppState::new(fallback_db, server_url)
                        .expect("Even fallback database initialization failed")
                }
            };

            app.manage(app_state);

            info!("BuddyLink setup complete - app is ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::get_public_key,
            commands::get_reconnect_info,
            commands::create_pair,
            commands::join_pair,
            commands::handle_pairing_result,
            commands::handle_reconnect_result,
            commands::send_encrypted_message,
            commands::send_poke,
            commands::decrypt_received_message,
            commands::get_message_history,
            commands::mark_messages_read,
            commands::send_read_receipt,
            commands::handle_read_receipt,
            commands::unpair,
            commands::update_status,
            commands::update_partner_status,
            commands::update_device_id,
            commands::set_server_url,
            commands::get_server_url,
            commands::set_my_icon,
            commands::set_my_name,
            commands::get_my_name,
            commands::set_my_avatar,
            commands::get_my_avatar,
            commands::set_partner_name,
            commands::set_partner_icon,
            commands::send_profile_update,
            commands::handle_profile_update,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        error!("Tauri runtime error: {}", e);
    } else {
        info!("BuddyLink exited normally");
    }
}
