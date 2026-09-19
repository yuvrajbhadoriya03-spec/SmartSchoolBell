# Smart School Bell — IoT Control System

An advanced, production-grade IoT Smart School Bell system powered by **ESP32**, featuring a futuristic anti-gravity dark glassmorphic web dashboard, hardware RTC integration, RFID admin security, capacitive touch manual trigger, independent emergency override, and automated timetable scheduling.

---

## 🌟 System Architecture

```
                    ┌──────────────────────────────┐
                    │  Antigravity Web Dashboard   │
                    │  (HTML5 / CSS3 / ES6 / REST) │
                    └──────────────┬───────────────┘
                                   │ HTTP / JSON (Port 80)
                                   ▼
                    ┌──────────────────────────────┐
                    │         ESP32 Node           │
                    │   Station IP: 10.225.96.148  │
                    └──────────────┬───────────────┘
          ┌──────────────┬─────────┴───────┬──────────────┬──────────────┐
          ▼              ▼                 ▼              ▼              ▼
     PCF8563 RTC    RC522 RFID        TTP223 Touch   Emergency BTN     Buzzer &
      (I2C 0x51)    (Admin Auth)       (Capacitive)   (Active LOW)    Status LEDs
     SDA:21/SCL:22  UID: 17:F1:74:06     GPIO 27        GPIO 33      GPIO 32, 12, 14
```

---

## 🚀 Key Features

1. **Anti-Gravity Glassmorphic UI**: Futuristic floating cards, canvas particle network, animated status indicators, and responsive mobile-ready layout.
2. **Hardware RTC Timekeeping**: PCF8563 on I2C address `0x51` keeps continuous accurate time, synchronized via NTP on boot.
3. **RFID Security Protocol**:
   - Master Admin UID: `17:F1:74:06`.
   - All configuration-changing REST APIs (`POST /api/timetable`, `PUT /api/timetable/:id`, `DELETE /api/timetable/:id`, `PUT /api/timetable/:id/toggle`) strictly enforce valid RFID authorization.
   - Reading status (`GET /api/status`) and timetable data remains public.
4. **Touch-to-Bell with One-Shot Auto-Lock**:
   - TTP223 capacitive touch sensor triggers a 3-second manual bell **only after RFID authentication**.
   - Automatically re-locks touch and manual bell immediately after ringing once. Re-scanning RFID is required for each subsequent trigger.
5. **Fail-Safe Emergency Bell**:
   - Dedicated hardware button on GPIO 33 (pull-up, active LOW) rings immediately for 3 seconds, bypassing RFID authentication.
   - Dashboard Emergency trigger is always armed and unlocked.
6. **Dashboard Timetable CRUD**: Add, edit, delete, and toggle school periods with automatic bell ring triggers at period start times.

---

## 🛠️ Hardware Pinout

| Component | Pin / Interface | ESP32 GPIO | Description |
|-----------|-----------------|------------|-------------|
| **PCF8563 RTC** | SDA / SCL | GPIO 21 / GPIO 22 | Hardware RTC (I2C `0x51`) |
| **RC522 RFID** | SS / RST | GPIO 5 / GPIO 4 | SPI Chip Select & Reset |
| **RC522 RFID** | SCK / MOSI / MISO | GPIO 18 / 23 / 19 | Standard Hardware VSPI |
| **TTP223 Touch** | OUT | GPIO 27 | Active HIGH capacitive touch |
| **Emergency Button** | Terminal 1 | GPIO 33 | Internal Pull-Up, Active LOW |
| **Buzzer** | Signal | GPIO 32 | Active HIGH sounder |
| **Red LED** | Anode | GPIO 12 | Active HIGH (Bell Active) |
| **Green LED** | Anode | GPIO 14 | Active HIGH (System Idle / OK) |

---

## 📡 REST API Specifications

| Method | Endpoint | Auth Required | Description |
|--------|----------|---------------|-------------|
| `GET` | `/api/status` | No | System health, RTC time/date, bell countdown, IP, and sensor states |
| `GET` | `/api/auth` | No | Current authentication status (`rfidAuthenticated`, `touchLocked`) |
| `POST` | `/api/auth/rfid` | No | Authenticate with UID JSON: `{"uid": "17:F1:74:06"}` |
| `POST` | `/api/auth/lock` | No | Manually revoke authorization and re-lock touch |
| `POST` | `/api/bell/manual` | **Yes (RFID)** | Trigger a 3-second manual bell (auto-locks after ring) |
| `POST` | `/api/bell/emergency`| No | Immediate 3-second emergency bell |
| `GET` | `/api/timetable` | No | Retrieve list of all scheduled periods |
| `POST` | `/api/timetable` | **Yes (RFID)** | Create a new period (`start`, `end`, `name`, `duration`) |
| `PUT` | `/api/timetable/:id` | **Yes (RFID)** | Update existing period |
| `DELETE` | `/api/timetable/:id` | **Yes (RFID)** | Delete period |
| `PUT` | `/api/timetable/:id/toggle` | **Yes (RFID)** | Toggle period enabled/disabled |

---

## 💻 Installation & Quickstart

### 1. ESP32 Firmware
1. Open [`SmartSchoolBell.ino`](SmartSchoolBell.ino) in Arduino IDE.
2. Install required libraries: `MFRC522`, `WiFi`, `WebServer`, `Wire`, `SPI`.
3. Copy `secrets.h.example` to `secrets.h` and configure your Wi-Fi credentials:
   ```cpp
   const char *WIFI_SSID = "Your_SSID";
   const char *WIFI_PASSWORD = "Your_Password";
   ```
4. Flash to ESP32 and open Serial Monitor (115200 baud) to note the assigned IP address.

### 2. Dashboard
The dashboard is pure HTML/CSS/Vanilla JavaScript with no build steps or heavy dependencies:
```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/smart-school-bell.git
cd smart-school-bell

# Launch local server
npm start
# or: npx -y serve@latest -l 3000
```
Open `http://localhost:3000` in your browser.

---

## 🔒 Security & Privacy

- Network credentials (`WIFI_SSID`, `WIFI_PASSWORD`) are externalized to `secrets.h` and ignored by `.gitignore`.
- Only the master RFID card UID (`17:F1:74:06`) can authorize timetable modifications or manual bell rings.
