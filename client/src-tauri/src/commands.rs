use crate::crypto::{self, KeyPair, EncryptedPayload};
use crate::db::{Database, PairingInfo, Message};
use std::sync::{Arc, Mutex};
use log::{info, warn};

/// State shared between Tauri commands
pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub keypair: Arc<Mutex<KeyPair>>,
    pub shared_secret: Arc<Mutex<Option<String>>>,
    pub device_id: Arc<Mutex<Option<String>>>,      // Persistent UUID
    pub partner_id: Arc<Mutex<Option<String>>>,
    pub partner_status: Arc<Mutex<String>>,          // "online", "offline", "unknown"
    pub server_url: Arc<Mutex<String>>,
    pub is_paired: Arc<Mutex<bool>>,
    pub my_name: Arc<Mutex<Option<String>>>,
    pub my_avatar: Arc<Mutex<Option<String>>>,       // base64 avatar data
    pub partner_name: Arc<Mutex<Option<String>>>,
    pub partner_avatar: Arc<Mutex<Option<String>>>,  // base64 avatar data
}

impl AppState {
    pub fn new(db_path: &str, server_url: &str) -> Result<Self, String> {
        let db = Database::new(db_path)?;

        // Try to restore keypair from database
        let existing_pairing = db.get_pairing()?;
        let keypair = if let Some(ref pairing) = existing_pairing {
            if let Some(ref priv_key) = pairing.my_private_key {
                // Restore existing keypair from stored private key
                info!("Restoring keypair from stored private key");
                crypto::restore_keypair_from_private(priv_key)?
            } else {
                // Old pairing without stored private key - generate new one
                // shared_secret is still valid since it was computed and stored during original pairing
                warn!("No stored private key found, generating new keypair");
                crypto::generate_keypair()
            }
        } else {
            // No existing pairing - generate fresh keypair
            crypto::generate_keypair()
        };

        // Restore pairing state from database
        let shared_secret = existing_pairing.as_ref()
            .map(|p| p.shared_secret.clone());
        let partner_id = existing_pairing.as_ref()
            .map(|p| p.partner_id.clone());
        let partner_name = existing_pairing.as_ref()
            .and_then(|p| p.partner_name.clone());
        let partner_avatar = existing_pairing.as_ref()
            .and_then(|p| {
                // partner_icon might be empty string instead of None
                if p.partner_icon.as_deref() == Some("") || p.partner_icon.is_none() {
                    None
                } else {
                    p.partner_icon.clone()
                }
            });
        let is_paired = existing_pairing.is_some();

        // Restore or generate persistent device UUID
        let device_uuid = db.get_setting("device_uuid")?;
        let device_id = if let Some(uuid) = device_uuid {
            info!("Restoring device UUID: {}", uuid);
            Some(uuid)
        } else {
            let new_uuid = crypto::generate_uuid();
            db.set_setting("device_uuid", &new_uuid)?;
            info!("Generated new device UUID: {}", new_uuid);
            Some(new_uuid)
        };

        // Restore user profile settings
        let my_name = db.get_setting("my_name")?;
        let my_avatar = db.get_setting("my_avatar")?;

        info!("App state initialized, paired: {}, deviceId: {}", is_paired, device_id.clone().unwrap_or_default());

        Ok(AppState {
            db: Arc::new(Mutex::new(db)),
            keypair: Arc::new(Mutex::new(keypair)),
            shared_secret: Arc::new(Mutex::new(shared_secret)),
            device_id: Arc::new(Mutex::new(device_id)),
            partner_id: Arc::new(Mutex::new(partner_id)),
            partner_status: Arc::new(Mutex::new(if is_paired { "unknown" } else { "none" }.to_string())),
            server_url: Arc::new(Mutex::new(server_url.to_string())),
            is_paired: Arc::new(Mutex::new(is_paired)),
            my_name: Arc::new(Mutex::new(my_name)),
            my_avatar: Arc::new(Mutex::new(my_avatar)),
            partner_name: Arc::new(Mutex::new(partner_name)),
            partner_avatar: Arc::new(Mutex::new(partner_avatar)),
        })
    }
}

// Tauri commands that the frontend can invoke

#[tauri::command]
pub fn get_app_state(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let is_paired = *state.is_paired.lock().unwrap();
    let partner_status = state.partner_status.lock().unwrap().clone();
    let device_id = state.device_id.lock().unwrap().clone();
    let my_name = state.my_name.lock().unwrap().clone();
    let my_avatar = state.my_avatar.lock().unwrap().clone();
    let partner_name = state.partner_name.lock().unwrap().clone();
    let partner_avatar = state.partner_avatar.lock().unwrap().clone();

    Ok(serde_json::json!({
        "is_paired": is_paired,
        "partner_status": partner_status,
        "device_id": device_id,
        "my_name": my_name,
        "my_avatar": my_avatar,
        "partner_name": partner_name,
        "partner_avatar": partner_avatar,
    }))
}

#[tauri::command]
pub fn get_public_key(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let keypair = state.keypair.lock().unwrap();
    Ok(keypair.public_key_base64.clone())
}

/// Get reconnect info - used when reconnecting to server after app restart
#[tauri::command]
pub fn get_reconnect_info(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let device_id = state.device_id.lock().unwrap().clone();
    let keypair = state.keypair.lock().unwrap();
    let is_paired = *state.is_paired.lock().unwrap();
    let my_name = state.my_name.lock().unwrap().clone();
    let my_avatar = state.my_avatar.lock().unwrap().clone();
    let partner_id = state.partner_id.lock().unwrap().clone();

    Ok(serde_json::json!({
        "type": "reconnect",
        "persistentUUID": device_id,
        "publicKey": keypair.public_key_base64,
        "isPaired": is_paired,
        "partnerId": partner_id,
        "name": my_name,
        "avatar": my_avatar,
    }))
}

#[tauri::command]
pub fn create_pair(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let keypair = state.keypair.lock().unwrap();
    let my_name = state.my_name.lock().unwrap().clone();
    let my_avatar = state.my_avatar.lock().unwrap().clone();

    Ok(serde_json::json!({
        "type": "create_pair",
        "deviceId": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "publicKey": keypair.public_key_base64,
        "name": my_name,
        "avatar": my_avatar,
    }))
}

#[tauri::command]
pub fn join_pair(state: tauri::State<'_, AppState>, code: String) -> Result<serde_json::Value, String> {
    let keypair = state.keypair.lock().unwrap();
    let my_name = state.my_name.lock().unwrap().clone();
    let my_avatar = state.my_avatar.lock().unwrap().clone();

    Ok(serde_json::json!({
        "type": "join_pair",
        "deviceId": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "code": code,
        "publicKey": keypair.public_key_base64,
        "name": my_name,
        "avatar": my_avatar,
    }))
}

#[tauri::command]
pub fn handle_pairing_result(
    state: tauri::State<'_, AppState>,
    partner_id: String,
    partner_public_key: String,
    partner_name: Option<String>,
    partner_avatar: Option<String>,
) -> Result<(), String> {
    let my_keypair = state.keypair.lock().unwrap();
    let shared = crypto::compute_shared_secret(&my_keypair.private_key_base64, &partner_public_key)?;

    *state.shared_secret.lock().unwrap() = Some(shared.clone());
    *state.partner_id.lock().unwrap() = Some(partner_id.clone());
    *state.is_paired.lock().unwrap() = true;
    *state.partner_name.lock().unwrap() = partner_name.clone();
    *state.partner_avatar.lock().unwrap() = partner_avatar.clone();

    let pairing_info = PairingInfo {
        partner_id,
        partner_name,
        partner_icon: partner_avatar.clone(),  // Store avatar as partner_icon
        my_public_key: my_keypair.public_key_base64.clone(),
        my_private_key: Some(my_keypair.private_key_base64.clone()),  // Persist private key!
        shared_secret: shared,
        paired_at: chrono::Utc::now().to_rfc3339(),
        is_active: true,
    };

    state.db.lock().unwrap().save_pairing(&pairing_info)?;
    info!("Pairing completed with partner: {}", pairing_info.partner_id);
    Ok(())
}

/// Handle reconnect_ack from server - restore pairing if server confirms
#[tauri::command]
pub fn handle_reconnect_result(
    state: tauri::State<'_, AppState>,
    device_id: String,
    is_paired: bool,
    partner_id: Option<String>,
) -> Result<(), String> {
    // Update device ID (server may confirm our persistent UUID)
    *state.device_id.lock().unwrap() = Some(device_id.clone());
    state.db.lock().unwrap().set_setting("device_uuid", &device_id)?;

    if is_paired && partner_id.is_some() {
        *state.is_paired.lock().unwrap() = true;
        *state.partner_id.lock().unwrap() = partner_id.clone();
        *state.partner_status.lock().unwrap() = "unknown".to_string();
        info!("Reconnect confirmed, paired with: {}", partner_id.unwrap());
    }

    Ok(())
}

#[tauri::command]
pub fn send_encrypted_message(
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<serde_json::Value, String> {
    let shared_secret = state.shared_secret.lock().unwrap();
    if shared_secret.is_none() {
        return Err("Not paired - cannot send message".to_string());
    }

    let payload = crypto::encrypt_message(shared_secret.as_ref().unwrap(), &content)?;

    // Save to local DB and get the message ID
    let msg_id = state.db.lock().unwrap().save_message_with_id("sent", &content)?;

    Ok(serde_json::json!({
        "type": "message",
        "from": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "to": state.partner_id.lock().unwrap().clone().unwrap_or_default(),
        "nonce": payload.nonce,
        "ciphertext": payload.ciphertext,
        "timestamp": chrono::Utc::now().timestamp(),
        "messageId": msg_id,
    }))
}

#[tauri::command]
pub fn send_poke(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let shared_secret = state.shared_secret.lock().unwrap();
    if shared_secret.is_none() {
        return Err("Not paired - cannot poke".to_string());
    }

    let payload = crypto::encrypt_message(shared_secret.as_ref().unwrap(), "poke")?;

    Ok(serde_json::json!({
        "type": "poke",
        "from": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "to": state.partner_id.lock().unwrap().clone().unwrap_or_default(),
        "nonce": payload.nonce,
        "ciphertext": payload.ciphertext,
        "timestamp": chrono::Utc::now().timestamp(),
    }))
}

#[tauri::command]
pub fn decrypt_received_message(
    state: tauri::State<'_, AppState>,
    nonce: String,
    ciphertext: String,
) -> Result<String, String> {
    let shared_secret = state.shared_secret.lock().unwrap();
    if shared_secret.is_none() {
        return Err("Not paired - cannot decrypt".to_string());
    }

    let payload = EncryptedPayload { nonce, ciphertext };
    let content = crypto::decrypt_message(shared_secret.as_ref().unwrap(), &payload)?;

    // Save to local DB
    state.db.lock().unwrap().save_message("received", &content)?;

    Ok(content)
}

#[tauri::command]
pub fn get_message_history(state: tauri::State<'_, AppState>, limit: i64) -> Result<Vec<Message>, String> {
    state.db.lock().unwrap().get_messages(limit)
}

#[tauri::command]
pub fn mark_messages_read(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.db.lock().unwrap().mark_messages_read()
}

/// Send read receipt for specific messages
#[tauri::command]
pub fn send_read_receipt(state: tauri::State<'_, AppState>, message_ids: Vec<i64>) -> Result<serde_json::Value, String> {
    // Mark received messages as read in local DB
    state.db.lock().unwrap().mark_messages_read_by_ids(&message_ids)?;

    Ok(serde_json::json!({
        "type": "read_receipt",
        "from": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "to": state.partner_id.lock().unwrap().clone().unwrap_or_default(),
        "messageIds": message_ids,
        "timestamp": chrono::Utc::now().timestamp(),
    }))
}

/// Handle incoming read receipt from partner - mark our sent messages as partner-read
#[tauri::command]
pub fn handle_read_receipt(
    state: tauri::State<'_, AppState>,
    message_ids: Vec<i64>,
) -> Result<(), String> {
    state.db.lock().unwrap().mark_sent_messages_read_by_ids(&message_ids)?;
    info!("Received read receipt for messages: {:?}", message_ids);
    Ok(())
}

#[tauri::command]
pub fn unpair(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    *state.shared_secret.lock().unwrap() = None;
    *state.partner_id.lock().unwrap() = None;
    *state.is_paired.lock().unwrap() = false;
    *state.partner_status.lock().unwrap() = "none".to_string();
    *state.partner_name.lock().unwrap() = None;
    *state.partner_avatar.lock().unwrap() = None;

    state.db.lock().unwrap().clear_pairing()?;
    info!("Unpaired successfully");

    Ok(serde_json::json!({
        "type": "unpair",
        "deviceId": state.device_id.lock().unwrap().clone().unwrap_or_default(),
    }))
}

#[tauri::command]
pub fn update_status(state: tauri::State<'_, AppState>, status: String) -> Result<serde_json::Value, String> {
    state.db.lock().unwrap().save_presence(&status)?;
    Ok(serde_json::json!({
        "type": "status_update",
        "deviceId": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "status": status,
    }))
}

#[tauri::command]
pub fn update_partner_status(state: tauri::State<'_, AppState>, status: String) -> Result<(), String> {
    *state.partner_status.lock().unwrap() = status;
    Ok(())
}

#[tauri::command]
pub fn update_device_id(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    *state.device_id.lock().unwrap() = Some(id.clone());
    state.db.lock().unwrap().set_setting("device_uuid", &id)?;
    Ok(())
}

#[tauri::command]
pub fn set_server_url(state: tauri::State<'_, AppState>, url: String) -> Result<(), String> {
    let url_clone = url.clone();
    *state.server_url.lock().unwrap() = url;
    state.db.lock().unwrap().set_setting("server_url", &url_clone)?;
    Ok(())
}

#[tauri::command]
pub fn get_server_url(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let url = state.server_url.lock().unwrap().clone();
    if url.is_empty() {
        let db_url = state.db.lock().unwrap().get_setting("server_url")?;
        if let Some(db_url) = db_url {
            *state.server_url.lock().unwrap() = db_url.clone();
            Ok(db_url)
        } else {
            Ok("wss://buddylink-relay-2.onrender.com".to_string())
        }
    } else {
        Ok(url)
    }
}

#[tauri::command]
pub fn set_my_icon(state: tauri::State<'_, AppState>, icon_path: String) -> Result<(), String> {
    state.db.lock().unwrap().set_setting("my_icon", &icon_path)?;
    Ok(())
}

#[tauri::command]
pub fn set_my_name(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    *state.my_name.lock().unwrap() = Some(name.clone());
    state.db.lock().unwrap().set_setting("my_name", &name)?;
    Ok(())
}

#[tauri::command]
pub fn get_my_name(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.my_name.lock().unwrap().clone())
}

#[tauri::command]
pub fn set_my_avatar(state: tauri::State<'_, AppState>, avatar: String) -> Result<(), String> {
    *state.my_avatar.lock().unwrap() = Some(avatar.clone());
    state.db.lock().unwrap().set_setting("my_avatar", &avatar)?;
    Ok(())
}

#[tauri::command]
pub fn get_my_avatar(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.my_avatar.lock().unwrap().clone())
}

#[tauri::command]
pub fn set_partner_name(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    *state.partner_name.lock().unwrap() = Some(name.clone());
    let pairing = state.db.lock().unwrap().get_pairing()?;
    if let Some(mut p) = pairing {
        p.partner_name = Some(name);
        state.db.lock().unwrap().save_pairing(&p)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_partner_icon(state: tauri::State<'_, AppState>, icon_path: String) -> Result<(), String> {
    *state.partner_avatar.lock().unwrap() = Some(icon_path.clone());
    let pairing = state.db.lock().unwrap().get_pairing()?;
    if let Some(mut p) = pairing {
        p.partner_icon = Some(icon_path);
        state.db.lock().unwrap().save_pairing(&p)?;
    }
    Ok(())
}

/// Send profile update (name/avatar change) to partner via relay
#[tauri::command]
pub fn send_profile_update(state: tauri::State<'_, AppState>, name: Option<String>, avatar: Option<String>) -> Result<serde_json::Value, String> {
    if name.is_some() {
        *state.my_name.lock().unwrap() = name.clone();
        if let Some(n) = &name {
            state.db.lock().unwrap().set_setting("my_name", n)?;
        }
    }
    if avatar.is_some() {
        *state.my_avatar.lock().unwrap() = avatar.clone();
        if let Some(a) = &avatar {
            state.db.lock().unwrap().set_setting("my_avatar", a)?;
        }
    }

    Ok(serde_json::json!({
        "type": "profile_update",
        "deviceId": state.device_id.lock().unwrap().clone().unwrap_or_default(),
        "name": name,
        "avatar": avatar,
    }))
}

/// Handle incoming profile update from partner
#[tauri::command]
pub fn handle_profile_update(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    avatar: Option<String>,
) -> Result<(), String> {
    if name.is_some() {
        *state.partner_name.lock().unwrap() = name.clone();
        let pairing = state.db.lock().unwrap().get_pairing()?;
        if let Some(mut p) = pairing {
            p.partner_name = name;
            state.db.lock().unwrap().save_pairing(&p)?;
        }
    }
    if avatar.is_some() {
        *state.partner_avatar.lock().unwrap() = avatar.clone();
        let pairing = state.db.lock().unwrap().get_pairing()?;
        if let Some(mut p) = pairing {
            p.partner_icon = avatar;
            state.db.lock().unwrap().save_pairing(&p)?;
        }
    }
    Ok(())
}
