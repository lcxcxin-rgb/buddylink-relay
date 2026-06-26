use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use log::{info, warn, error};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEvent {
    pub event_type: String,
    pub data: Value,
}

pub struct RelayClient {
    server_url: String,
    device_id: Arc<Mutex<Option<String>>>,
    event_sender: mpsc::UnboundedSender<RelayEvent>,
    connected: Arc<Mutex<bool>>,
}

impl RelayClient {
    pub fn new(server_url: &str, event_sender: mpsc::UnboundedSender<RelayEvent>) -> Self {
        RelayClient {
            server_url: server_url.to_string(),
            device_id: Arc::new(Mutex::new(None)),
            event_sender,
            connected: Arc::new(Mutex::new(false)),
        }
    }

    pub fn get_device_id(&self) -> Option<String> {
        self.device_id.lock().unwrap().clone()
    }

    pub fn is_connected(&self) -> bool {
        *self.connected.lock().unwrap()
    }

    /// Connect to relay server and listen for events
    pub async fn connect(&self) -> Result<(), String> {
        info!("Connecting to relay server: {}", self.server_url);

        let (mut ws_stream, _) = connect_async(&self.server_url)
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        *self.connected.lock().unwrap() = true;
        info!("Connected to relay server");

        // Read messages from server
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    if let Ok(event) = serde_json::from_str::<Value>(&text) {
                        let event_type = event.get("type")
                            .and_then(|t| t.as_str())
                            .unwrap_or("unknown")
                            .to_string();

                        // Handle assigned_id event
                        if event_type == "assigned_id" {
                            let id = event.get("deviceId")
                                .and_then(|d| d.as_str())
                                .unwrap_or("")
                                .to_string();
                            *self.device_id.lock().unwrap() = Some(id.clone());
                            info!("Assigned device ID: {}", id);
                        }

                        let relay_event = RelayEvent {
                            event_type,
                            data: event,
                        };

                        if self.event_sender.send(relay_event).is_err() {
                            warn!("Event channel closed");
                            break;
                        }
                    }
                }
                Ok(WsMessage::Close(_)) => {
                    info!("Server closed connection");
                    *self.connected.lock().unwrap() = false;
                    break;
                }
                Err(e) => {
                    error!("WebSocket error: {}", e);
                    *self.connected.lock().unwrap() = false;
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Send a message to the relay server
    pub async fn send_message(&self, msg: &Value) -> Result<(), String> {
        info!("Sending message: {:?}", msg);
        Ok(())
    }
}
