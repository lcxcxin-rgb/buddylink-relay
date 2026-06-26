# BuddyLink — Mac配对互动桌面组件 开发计划

## 项目概述

BuddyLink 是一款轻量 Mac 桌面组件应用，让两台 Mac（即使不在同一网络）通过配对密钥建立连接，实现留言、状态更新、戳一戳等互动功能。未配对时以小图标形态驻留 Dock栏，点击弹出可拖动浮动面板。

## 技术决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 客户端框架 | **Tauri (Rust + WebView)** | 体积极小(~5MB)、UI定制灵活(HTML/CSS)、Rust后端可靠 |
| 中继服务器 | **自建 Node.js WebSocket** | 完全掌控数据、可部署任意云服务器、零第三方依赖 |
| 加密方案 | **端到端加密 (ECDH + AES-GCM)** | 中继只转发密文、即使服务器被入侵也无法读取内容 |
| 分发方式 | **直接下载 dmg** | 无需Apple审核、快速迭代、用户安装简单 |
| 本地存储 | **SQLite (通过 Rust rusqlite)** | 嵌入式数据库、零配置、历史记录可靠持久化 |

## 系统架构

```
┌─────────────┐     WebSocket      ┌───────────────┐     WebSocket      ┌─────────────┐
│   Mac A     │ ────(TLS)────────→ │  Relay Server  │ ────(TLS)────────→ │   Mac B     │
│             │                    │               │                    │             │
│ Tauri App   │ ←──加密密文────── │  Node.js      │ ←──加密密文────── │ Tauri App   │
│ SQLite DB   │                    │  只转发不存储 │                    │ SQLite DB   │
│ Float Panel │                    │  配对密钥匹配 │                    │ Float Panel │
└─────────────┘                    └───────────────┘                    └─────────────┘
```

### 通信流程

1. **连接建立**: 客户端启动后通过 TLS WebSocket 连接到中继服务器
2. **配对流程**:
   - Mac A 点击"生成配对密钥" → 生成6位随机码 + ECDH公钥 → 注册到服务器
   - Mac B 输入配对密钥 → 服务器匹配 → 双方交换公钥
   - 双方各自计算共享密钥 → 之后所有消息用 AES-GCM 加密
3. **日常通信**: 加密消息通过中继转发，对方用共享密钥解密
4. **状态同步**: 心跳包每30秒发送，服务器广播在线/离线状态变更

### 端到端加密细节

- **密钥交换**: ECDH (Curve25519) — 配对时双方交换公钥，计算共享密钥
- **消息加密**: AES-256-GCM — 用共享密钥加密，每条消息随机nonce
- **中继服务器**: 只看到 `{type, from, to, encrypted_payload}` — 无法解密内容
- **密钥轮换**: 支持重新配对时自动更新密钥

## 项目结构

```
buddylink/
├── server/                    # 中继服务器
│   ├── package.json
│   ├── src/
│   │   ├── index.js           # 服务器入口
│   │   ├── relay.js           # WebSocket消息转发逻辑
│   │   ├── pairing.js         # 配对密钥匹配逻辑
│   │   └── presence.js        # 在线状态追踪
│   └── Dockerfile             # 可选: Docker部署
│
├── client/                    # Tauri客户端
│   ├── src-tauri/             # Rust后端
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── main.rs        # Tauri入口 + 窗口配置
│   │   │   ├── relay.rs       # WebSocket客户端连接
│   │   │   ├── crypto.rs      # ECDH密钥交换 + AES加密
│   │   │   ├── db.rs          # SQLite操作
│   │   │   ├── commands.rs    # Tauri命令(前端调用)
│   │   │   └── config.rs      # 应用配置
│   │   └── icons/             # 默认图标资源
│   │   └── tauri.conf.json    # Tauri配置
│   │
│   ├── src/                   # 前端(HTML/CSS/JS)
│   │   ├── main.js            # 应用入口
│   │   ├── styles.css         # 样式
│   │   ├── components/
│   │   │   ├── PairView.js    # 配对界面
│   │   │   ├── ChatView.js    # 留言界面
│   │   │   ├── StatusBar.js   # 状态栏
│   │   │   ├── PokeButton.js  # 戳一戳按钮
│   │   │   ├── IconPicker.js  # 图标自定义
│   │   │   └── HistoryView.js # 历史记录
│   │   └── assets/
│   │       └── icons/         # 预置图标
│   │
│   ├── package.json
│   └── vite.config.js         # Vite构建配置(可选)
│
└── docs/
    └── DEVELOPMENT.md         # 本文件
```

## 数据库设计 (SQLite)

### messages 表
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL,
    direction TEXT NOT NULL,       -- 'sent' / 'received'
    encrypted_payload TEXT,        -- 原始加密数据(可选保存)
    content TEXT NOT NULL,         -- 解密后的内容
    read BOOLEAN DEFAULT FALSE
);
```

### presence_log 表
```sql
CREATE TABLE presence_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL,
    status TEXT NOT NULL           -- 'online' / 'offline' / 'away'
);
```

### pairing 表
```sql
CREATE TABLE pairing (
    id INTEGER PRIMARY KEY,
    partner_id TEXT NOT NULL,      -- 服务器分配的设备ID
    partner_name TEXT,             -- 对方昵称(可选)
    partner_icon TEXT,             -- 对方图标路径(可选)
    my_public_key TEXT NOT NULL,
    shared_secret TEXT NOT NULL,   -- ECDH计算出的共享密钥
    paired_at DATETIME NOT NULL,
    is_active BOOLEAN DEFAULT TRUE
);
```

### settings 表
```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 存储: my_icon_path, my_name, server_url, device_id
```

## WebSocket协议 (客户端↔服务器)

### 消息格式 (JSON)

```json
// 注册设备
{ "type": "register", "deviceId": "xxx", "publicKey": "ECDH公钥base64" }

// 生成配对密钥
{ "type": "create_pair", "deviceId": "xxx", "publicKey": "ECDH公钥base64" }
→ 响应: { "type": "pair_code", "code": "A3K9F2" }

// 输入配对密钥
{ "type": "join_pair", "deviceId": "xxx", "code": "A3K9F2", "publicKey": "ECDH公钥base64" }
→ 响应(双方): { "type": "paired", "partnerId": "xxx", "partnerPublicKey": "..." }

// 发送加密消息
{ "type": "message", "from": "xxx", "to": "xxx", "nonce": "...", "ciphertext": "...", "timestamp": 1234567890 }

// 心跳
{ "type": "heartbeat", "deviceId": "xxx" }

// 状态变更广播
{ "type": "presence", "deviceId": "xxx", "status": "online/offline/away" }

// 戳一戳
{ "type": "poke", "from": "xxx", "to": "xxx", "nonce": "...", "ciphertext": "..." }
```

## 开发阶段

### Phase 1: 基础搭建 (预估 2-3天)
- [ ] 初始化 Tauri 项目
- [ ] 配置窗口行为(无装饰、透明背景、可拖动、始终在Dock显示)
- [ ] 搭建 Node.js 中继服务器骨架
- [ ] 实现 WebSocket 基础连接与心跳

### Phase 2: 配对系统 (预估 2-3天)
- [ ] 实现配对密钥生成与输入UI
- [ ] 服务器端配对密钥匹配逻辑
- [ ] ECDH 公钥交换
- [ ] 共享密钥计算与本地存储
- [ ] AES-GCM 加密/解密实现

### Phase 3: 核心功能 (预估 3-4天)
- [ ] 留言发送/接收(加密)
- [ ] 在线状态更新与推送
- [ ] 戳一戳互动 + 动画效果
- [ ] SQLite 数据存储与历史记录查看

### Phase 4: UI与自定义 (预估 2-3天)
- [ ] 浮动面板UI设计(未配对/已配对两种状态)
- [ ] 自定义图标上传/选择
- [ ] 面板可拖动交互优化
- [ ] Dock图标动态更新

### Phase 5: 打包与优化 (预估 1-2天)
- [ ] dmg 打包配置
- [ ] 应用图标与签名(可选)
- [ ] 网络断线重连机制
- [ ] 性能优化与测试

## 部署说明

### 中继服务器部署
- 接入任意云服务器(腾讯云/AWS/Vultr等)
- 建议使用 Docker 部署，一键启动
- 需要 TLS 证书(可用 Let's Encrypt)
- 默认端口: 8443 (WSS)

### 客户端配置
- 首次启动时输入服务器地址(或使用默认公共服务器)
- 服务器地址保存在本地设置中，可随时更改
