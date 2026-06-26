use rusqlite::{Connection, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use chrono::Utc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub timestamp: String,
    pub direction: String,
    pub content: String,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceEntry {
    pub id: i64,
    pub timestamp: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingInfo {
    pub partner_id: String,
    pub partner_name: Option<String>,
    pub partner_icon: Option<String>,
    pub my_public_key: String,
    pub my_private_key: Option<String>,  // Persisted for restart recovery
    pub shared_secret: String,
    pub paired_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(db_path: &str) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open database: {}", e))?;
        let db = Database { conn };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> Result<(), String> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                direction TEXT NOT NULL,
                content TEXT NOT NULL,
                read INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS presence_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pairing (
                id INTEGER PRIMARY KEY,
                partner_id TEXT NOT NULL,
                partner_name TEXT,
                partner_icon TEXT,
                my_public_key TEXT NOT NULL,
                my_private_key TEXT,
                shared_secret TEXT NOT NULL,
                paired_at TEXT NOT NULL,
                is_active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).map_err(|e| format!("Failed to create tables: {}", e))?;

        // Migration: add my_private_key column if it doesn't exist (for existing DBs)
        let _has_private_key: bool = self.conn.execute_batch(
            "ALTER TABLE pairing ADD COLUMN my_private_key TEXT"
        ).is_ok();  // This will fail silently if column already exists, which is fine

        Ok(())
    }

    pub fn save_message(&self, direction: &str, content: &str) -> Result<i64, String> {
        let timestamp = Utc::now().to_rfc3339();
        let read_flag: i32 = if direction == "sent" { 1 } else { 0 };
        self.conn.execute(
            "INSERT INTO messages (timestamp, direction, content, read) VALUES (?1, ?2, ?3, ?4)",
            params![timestamp, direction, content, read_flag],
        ).map_err(|e| format!("Failed to save message: {}", e))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Save message and return the inserted row ID (for read receipt tracking)
    pub fn save_message_with_id(&self, direction: &str, content: &str) -> Result<i64, String> {
        let id = self.save_message(direction, content)?;
        Ok(id)
    }

    pub fn get_messages(&self, limit: i64) -> Result<Vec<Message>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, direction, content, read FROM messages ORDER BY id DESC LIMIT ?1"
        ).map_err(|e| format!("Failed to prepare query: {}", e))?;

        let msgs = stmt.query_map(params![limit], |row| {
            let read_val: i32 = row.get(4)?;
            Ok(Message {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                direction: row.get(2)?,
                content: row.get(3)?,
                read: read_val != 0,
            })
        }).map_err(|e| format!("Failed to query messages: {}", e))?
        .collect::<SqlResult<Vec<Message>>>()
        .map_err(|e| format!("Failed to collect messages: {}", e))?;

        Ok(msgs)
    }

    pub fn mark_messages_read(&self) -> Result<(), String> {
        self.conn.execute(
            "UPDATE messages SET read = 1 WHERE direction = 'received' AND read = 0",
            [],
        ).map_err(|e| format!("Failed to mark messages read: {}", e))?;
        Ok(())
    }

    /// Mark specific messages as read by their IDs
    pub fn mark_messages_read_by_ids(&self, ids: &[i64]) -> Result<(), String> {
        for id in ids {
            self.conn.execute(
                "UPDATE messages SET read = 1 WHERE id = ?1 AND direction = 'received'",
                params![id],
            ).map_err(|e| format!("Failed to mark message {} read: {}", id, e))?;
        }
        Ok(())
    }

    /// Mark sent messages as read when partner confirms read receipt
    pub fn mark_sent_messages_read_by_ids(&self, ids: &[i64]) -> Result<(), String> {
        for id in ids {
            self.conn.execute(
                "UPDATE messages SET read = 1 WHERE id = ?1 AND direction = 'sent'",
                params![id],
            ).map_err(|e| format!("Failed to mark sent message {} as partner-read: {}", id, e))?;
        }
        Ok(())
    }

    pub fn save_presence(&self, status: &str) -> Result<(), String> {
        let timestamp = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO presence_log (timestamp, status) VALUES (?1, ?2)",
            params![timestamp, status],
        ).map_err(|e| format!("Failed to save presence: {}", e))?;
        Ok(())
    }

    pub fn save_pairing(&self, info: &PairingInfo) -> Result<(), String> {
        let partner_name = info.partner_name.as_deref().unwrap_or("");
        let partner_icon = info.partner_icon.as_deref().unwrap_or("");
        let my_private_key = info.my_private_key.as_deref().unwrap_or("");
        let is_active_flag: i32 = if info.is_active { 1 } else { 0 };
        self.conn.execute(
            "INSERT OR REPLACE INTO pairing (id, partner_id, partner_name, partner_icon, my_public_key, my_private_key, shared_secret, paired_at, is_active)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![info.partner_id, partner_name, partner_icon, info.my_public_key, my_private_key, info.shared_secret, info.paired_at, is_active_flag],
        ).map_err(|e| format!("Failed to save pairing: {}", e))?;
        Ok(())
    }

    pub fn get_pairing(&self) -> Result<Option<PairingInfo>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT partner_id, partner_name, partner_icon, my_public_key, my_private_key, shared_secret, paired_at, is_active FROM pairing WHERE id = 1 AND is_active = 1"
        ).map_err(|e| format!("Failed to prepare query: {}", e))?;

        let result = stmt.query_row([], |row| {
            let is_active_val: i32 = row.get(7)?;
            let my_private_key: Option<String> = row.get(4)?;
            Ok(PairingInfo {
                partner_id: row.get(0)?,
                partner_name: row.get(1)?,
                partner_icon: row.get(2)?,
                my_public_key: row.get(3)?,
                my_private_key,
                shared_secret: row.get(5)?,
                paired_at: row.get(6)?,
                is_active: is_active_val != 0,
            })
        });

        match result {
            Ok(info) => Ok(Some(info)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to get pairing: {}", e)),
        }
    }

    pub fn clear_pairing(&self) -> Result<(), String> {
        self.conn.execute(
            "UPDATE pairing SET is_active = 0 WHERE id = 1",
            [],
        ).map_err(|e| format!("Failed to clear pairing: {}", e))?;
        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        ).map_err(|e| format!("Failed to save setting: {}", e))?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let result: Result<String, rusqlite::Error> = self.conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        );
        match result {
            Ok(val) => Ok(Some(val)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to get setting: {}", e)),
        }
    }
}
