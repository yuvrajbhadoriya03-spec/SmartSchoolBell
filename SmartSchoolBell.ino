#include <MFRC522.h>
#include <Preferences.h>
#include <SPI.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Wire.h>
#include <sys/time.h>
#include <time.h>


// =====================================================
// WIFI CREDENTIALS (Loaded from secrets.h, excluded from Git)
// =====================================================
#if __has_include("secrets.h")
#include "secrets.h"
#else
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
#endif

// India timezone
const long GMT_OFFSET_SEC = 19800;
const int DAYLIGHT_OFFSET_SEC = 0;

// =====================================================
// PINS
// =====================================================
#define I2C_SDA 21
#define I2C_SCL 22

#define RFID_SS 5
#define RFID_RST 4
#define RFID_SCK 18
#define RFID_MOSI 23
#define RFID_MISO 19

#define TTP223_PIN 27
#define EMERGENCY_PIN 33

#define BUZZER_PIN 32
#define GREEN_LED 14
#define RED_LED 12

// =====================================================
// PCF8563
// =====================================================
#define PCF8563_ADDR 0x51

bool rtcAvailable = false;

// =====================================================
// RFID
// =====================================================
const String ADMIN_UID = "17:F1:74:06";

// =====================================================
// OBJECTS
// =====================================================
WebServer server(80);
Preferences timetablePrefs;

MFRC522 rfid(RFID_SS, RFID_RST);

// =====================================================
// BELL
// =====================================================
bool bellActive = false;
bool bellIsEmergency = false;

unsigned long bellStartTime = 0;
unsigned long bellDuration = 3000; // 3 seconds

// =====================================================
// AUTH
// =====================================================
bool rfidAuthenticated = false;
bool touchEnabled = false;
bool touchLocked = true;
bool manualBellLocked = true;

String lastRfidUid = "";

bool lastTouchState = false;
bool lastEmergencyState = HIGH;

// =====================================================
// DASHBOARD TIMETABLE
// Dashboard fields: id, period, start, end, name, duration, enabled
// =====================================================
#define MAX_TIMETABLE_ENTRIES 30

struct TimetableEntry {
  int id;
  int period;
  String start;
  String end;
  String name;
  int duration;
  bool enabled;
};

TimetableEntry timetable[MAX_TIMETABLE_ENTRIES];
int timetableCount = 0;
int nextTimetableId = 1;
String lastAutoBellKey = "";

// =====================================================
// TIMING
// =====================================================
unsigned long lastWiFiCheck = 0;
unsigned long lastNTPSync = 0;

bool ntpSyncDone = false;

// =====================================================
// FORWARD DECLARATIONS
// =====================================================
void stopBell();
void lockAuthentication();
void loadTimetable();
void saveTimetable();
void checkAutomaticBell();
void handleTimetableGet();
void handleTimetablePost();
void handleTimetableDynamic();

// =====================================================
// BCD HELPERS
// =====================================================
uint8_t bcdToDec(uint8_t value) { return ((value >> 4) * 10) + (value & 0x0F); }

uint8_t decToBcd(uint8_t value) { return ((value / 10) << 4) | (value % 10); }

// =====================================================
// PCF8563 READ
//
// Registers:
// 0x02 Seconds
// 0x03 Minutes
// 0x04 Hours
// 0x05 Day
// 0x06 Weekday
// 0x07 Month/Century
// 0x08 Year
// =====================================================
bool readPCF8563(uint8_t &second, uint8_t &minute, uint8_t &hour, uint8_t &day,
                 uint8_t &month, uint16_t &year) {

  Wire.beginTransmission(PCF8563_ADDR);
  Wire.write(0x02);

  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  if (Wire.requestFrom(PCF8563_ADDR, (uint8_t)7) != 7) {
    return false;
  }

  uint8_t secReg = Wire.read();
  uint8_t minReg = Wire.read();
  uint8_t hourReg = Wire.read();
  uint8_t dayReg = Wire.read();

  Wire.read(); // weekday

  uint8_t monthReg = Wire.read();
  uint8_t yearReg = Wire.read();

  // Voltage-low / oscillator-stop flag
  if (secReg & 0x80) {
    return false;
  }

  second = bcdToDec(secReg & 0x7F);
  minute = bcdToDec(minReg & 0x7F);
  hour = bcdToDec(hourReg & 0x3F);
  day = bcdToDec(dayReg & 0x3F);
  month = bcdToDec(monthReg & 0x1F);

  // Century bit:
  // 0 = 2000s
  // 1 = 1900s
  if (monthReg & 0x80) {
    year = 1900 + yearReg;
  } else {
    year = 2000 + yearReg;
  }

  if (second > 59 || minute > 59 || hour > 23 || day < 1 || day > 31 ||
      month < 1 || month > 12) {

    return false;
  }

  return true;
}

// =====================================================
// PCF8563 WRITE
// =====================================================
bool writePCF8563(uint8_t second, uint8_t minute, uint8_t hour, uint8_t day,
                  uint8_t weekday, uint8_t month, uint16_t year) {

  if (year < 2000 || year > 2099) {
    return false;
  }

  Wire.beginTransmission(PCF8563_ADDR);

  Wire.write(0x02);

  // Clear VL bit while writing seconds
  Wire.write(decToBcd(second) & 0x7F);

  Wire.write(decToBcd(minute) & 0x7F);
  Wire.write(decToBcd(hour) & 0x3F);
  Wire.write(decToBcd(day) & 0x3F);
  Wire.write(weekday & 0x07);

  // 2000-2099 => century bit = 0
  Wire.write(decToBcd(month) & 0x1F);

  Wire.write(decToBcd(year - 2000));

  return Wire.endTransmission() == 0;
}

// =====================================================
// GET SYSTEM TIME
// =====================================================
bool getSystemTime(uint8_t &second, uint8_t &minute, uint8_t &hour,
                   uint8_t &day, uint8_t &month, uint16_t &year,
                   uint8_t &weekday) {

  time_t now = time(nullptr);

  if (now < 1700000000) {
    return false;
  }

  struct tm timeinfo;

  if (!localtime_r(&now, &timeinfo)) {
    return false;
  }

  second = timeinfo.tm_sec;
  minute = timeinfo.tm_min;
  hour = timeinfo.tm_hour;
  day = timeinfo.tm_mday;
  month = timeinfo.tm_mon + 1;
  year = timeinfo.tm_year + 1900;
  weekday = timeinfo.tm_wday;

  return true;
}

// =====================================================
// SYNC SYSTEM TIME -> PCF8563
// =====================================================
bool syncRTCFromNTP() {

  struct tm timeinfo;

  // Wait for SNTP time to become available.
  if (!getLocalTime(&timeinfo, 1000)) {
    Serial.println("NTP time not ready yet.");
    return false;
  }

  uint16_t year = timeinfo.tm_year + 1900;

  // Reject invalid/default RTC/system dates.
  // This project is currently operating in the 2020s.
  if (year < 2025 || year > 2099) {
    Serial.printf("Invalid NTP year received: %u\\n", year);
    return false;
  }

  uint8_t second = timeinfo.tm_sec;
  uint8_t minute = timeinfo.tm_min;
  uint8_t hour = timeinfo.tm_hour;
  uint8_t day = timeinfo.tm_mday;
  uint8_t month = timeinfo.tm_mon + 1;
  uint8_t weekday = timeinfo.tm_wday;

  bool result = writePCF8563(second, minute, hour, day, weekday, month, year);

  if (result) {

    Serial.println("--------------------------------");
    Serial.println("PCF8563 SYNCED FROM NTP");

    Serial.printf("Date: %02d/%02d/%04d\\n", day, month, year);

    Serial.printf("Time: %02d:%02d:%02d\\n", hour, minute, second);

    Serial.println("--------------------------------");

    ntpSyncDone = true;
    return true;
  }

  Serial.println("PCF8563 write failed.");
  return false;
}
// =====================================================
// SET ESP32 SYSTEM TIME FROM PCF8563
// =====================================================
bool syncSystemTimeFromRTC() {

  uint8_t second;
  uint8_t minute;
  uint8_t hour;
  uint8_t day;
  uint8_t month;
  uint16_t year;

  if (!readPCF8563(second, minute, hour, day, month, year)) {

    return false;
  }

  if (year < 2024 || year > 2099) {
    return false;
  }

  struct tm rtcTime = {};

  rtcTime.tm_sec = second;
  rtcTime.tm_min = minute;
  rtcTime.tm_hour = hour;
  rtcTime.tm_mday = day;
  rtcTime.tm_mon = month - 1;
  rtcTime.tm_year = year - 1900;
  rtcTime.tm_isdst = 0;

  time_t timestamp = mktime(&rtcTime);

  if (timestamp <= 0) {
    return false;
  }

  struct timeval tv;

  tv.tv_sec = timestamp;
  tv.tv_usec = 0;

  settimeofday(&tv, nullptr);

  Serial.println("ESP32 system time loaded from PCF8563.");

  return true;
}

// =====================================================
// RTC VALID
// =====================================================
bool isRTCValid() {

  uint8_t second;
  uint8_t minute;
  uint8_t hour;
  uint8_t day;
  uint8_t month;
  uint16_t year;

  if (!rtcAvailable) {
    return false;
  }

  if (!readPCF8563(second, minute, hour, day, month, year)) {

    return false;
  }

  if (year < 2024 || year > 2099) {
    return false;
  }

  return true;
}

// =====================================================
// TIME STRING
// ESP32 system/NTP time is authoritative for dashboard time.
// PCF8563 is used only as a fallback when system time is unavailable.
// =====================================================
String getTimeString() {
  time_t now = time(nullptr);

  if (now >= 1700000000) {
    struct tm timeinfo;
    if (localtime_r(&now, &timeinfo)) {
      char buffer[12];
      snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d", timeinfo.tm_hour,
               timeinfo.tm_min, timeinfo.tm_sec);
      return String(buffer);
    }
  }

  uint8_t second, minute, hour, day, month;
  uint16_t year;
  if (!readPCF8563(second, minute, hour, day, month, year)) {
    return "00:00:00";
  }

  char buffer[12];
  snprintf(buffer, sizeof(buffer), "%02d:%02d:%02d", hour, minute, second);
  return String(buffer);
}

// =====================================================
// DATE STRING
// =====================================================
String getDateString() {
  time_t now = time(nullptr);

  if (now >= 1700000000) {
    struct tm timeinfo;
    if (localtime_r(&now, &timeinfo)) {
      char buffer[16];
      snprintf(buffer, sizeof(buffer), "%02d/%02d/%04d", timeinfo.tm_mday,
               timeinfo.tm_mon + 1, timeinfo.tm_year + 1900);
      return String(buffer);
    }
  }

  uint8_t second, minute, hour, day, month;
  uint16_t year;
  if (!readPCF8563(second, minute, hour, day, month, year)) {
    return "01/01/2000";
  }

  char buffer[16];
  snprintf(buffer, sizeof(buffer), "%02d/%02d/%04d", day, month, year);
  return String(buffer);
}

// =====================================================
// CORS
// =====================================================
void addCORS() {

  server.sendHeader("Access-Control-Allow-Origin", "*");

  server.sendHeader("Access-Control-Allow-Methods",
                    "GET,POST,PUT,DELETE,OPTIONS");

  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

// =====================================================
// JSON
// =====================================================
void sendJSON(int code, String json) {

  addCORS();

  server.send(code, "application/json", json);
}

// =====================================================
// UID STRING
// =====================================================
String getUIDString() {

  String uid = "";

  for (byte i = 0; i < rfid.uid.size; i++) {

    if (rfid.uid.uidByte[i] < 0x10) {
      uid += "0";
    }

    uid += String(rfid.uid.uidByte[i], HEX);

    if (i < rfid.uid.size - 1) {
      uid += ":";
    }
  }

  uid.toUpperCase();

  return uid;
}

// =====================================================
// RFID UNLOCK
// =====================================================
void unlockByRFID(String uid) {

  uid.toUpperCase();

  if (uid == ADMIN_UID) {

    rfidAuthenticated = true;
    touchEnabled = true;
    touchLocked = false;
    manualBellLocked = false;

    lastRfidUid = uid;

    Serial.println();
    Serial.println("================================");
    Serial.println("ADMIN RFID AUTHORIZED");
    Serial.println("TOUCH BELL UNLOCKED");
    Serial.println("================================");

  } else {

    Serial.println();
    Serial.println("Unauthorized RFID:");
    Serial.println(uid);

    rfidAuthenticated = false;
    touchEnabled = false;
    touchLocked = true;
    manualBellLocked = true;

    lastRfidUid = uid;
  }
}

// =====================================================
// LOCK AUTH
// =====================================================
void lockAuthentication() {

  rfidAuthenticated = false;
  touchEnabled = false;
  touchLocked = true;
  manualBellLocked = true;

  Serial.println("Authentication LOCKED");
}

// =====================================================
// START BELL
// =====================================================
void startBell(bool emergency = false) {

  bellActive = true;
  bellIsEmergency = emergency;

  bellStartTime = millis();

  digitalWrite(BUZZER_PIN, HIGH);

  digitalWrite(RED_LED, HIGH);

  digitalWrite(GREEN_LED, LOW);

  Serial.println("--------------------------------");

  if (emergency) {
    Serial.println("EMERGENCY BELL");
  } else {
    Serial.println("MANUAL / AUTOMATIC BELL");
  }

  Serial.println("--------------------------------");
}

// =====================================================
// STOP BELL
// =====================================================
void stopBell() {

  bellActive = false;
  bellIsEmergency = false;

  digitalWrite(BUZZER_PIN, LOW);

  digitalWrite(RED_LED, LOW);

  digitalWrite(GREEN_LED, HIGH);

  Serial.println("Bell stopped");
}

// =====================================================
// BELL UPDATE
// =====================================================
void updateBell() {

  if (!bellActive) {
    return;
  }

  if (millis() - bellStartTime >= bellDuration) {

    stopBell();
  }
}

// =====================================================
// TIMETABLE HELPERS
// =====================================================
String jsonEscape(const String &value) {
  String out = "";
  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    if (c == '\\')
      out += "\\\\";
    else if (c == '"')
      out += "\\\"";
    else if (c == '\n')
      out += "\\n";
    else if (c == '\r')
      out += "\\r";
    else
      out += c;
  }
  return out;
}

String fieldString(const String &body, const char *key,
                   const String &fallback = "") {
  String needle = String("\"") + key + "\"";
  int pos = body.indexOf(needle);
  if (pos < 0)
    return fallback;
  int colon = body.indexOf(':', pos + needle.length());
  if (colon < 0)
    return fallback;
  int q1 = body.indexOf('"', colon + 1);
  if (q1 < 0)
    return fallback;
  int q2 = q1 + 1;
  while (q2 < (int)body.length()) {
    if (body[q2] == '"' && body[q2 - 1] != '\\')
      break;
    q2++;
  }
  if (q2 >= (int)body.length())
    return fallback;
  return body.substring(q1 + 1, q2);
}

String fieldRaw(const String &body, const char *key,
                const String &fallback = "") {
  String needle = String("\"") + key + "\"";
  int pos = body.indexOf(needle);
  if (pos < 0)
    return fallback;
  int colon = body.indexOf(':', pos + needle.length());
  if (colon < 0)
    return fallback;
  int start = colon + 1;
  while (start < (int)body.length() &&
         (body[start] == ' ' || body[start] == '\t'))
    start++;
  int end = start;
  while (end < (int)body.length() && body[end] != ',' && body[end] != '}')
    end++;
  String value = body.substring(start, end);
  value.trim();
  return value;
}

int fieldInt(const String &body, const char *key, int fallback = 0) {
  String v = fieldRaw(body, key, "");
  if (v.length() == 0)
    return fallback;
  return v.toInt();
}

bool fieldBool(const String &body, const char *key, bool fallback = true) {
  String v = fieldRaw(body, key, "");
  v.toLowerCase();
  if (v == "true" || v == "1")
    return true;
  if (v == "false" || v == "0")
    return false;
  return fallback;
}

bool validTimeHHMM(const String &t) {
  if (t.length() != 5 || t[2] != ':')
    return false;
  int h = t.substring(0, 2).toInt();
  int m = t.substring(3, 5).toInt();
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

void loadTimetable() {
  timetableCount = timetablePrefs.getInt("count", 0);
  nextTimetableId = timetablePrefs.getInt("nextId", 1);

  if (timetableCount < 0 || timetableCount > MAX_TIMETABLE_ENTRIES)
    timetableCount = 0;
  if (nextTimetableId < 1)
    nextTimetableId = 1;

  for (int i = 0; i < timetableCount; i++) {
    String key = "e" + String(i);
    String raw = timetablePrefs.getString(key.c_str(), "");
    int p1 = raw.indexOf('|');
    int p2 = raw.indexOf('|', p1 + 1);
    int p3 = raw.indexOf('|', p2 + 1);
    int p4 = raw.indexOf('|', p3 + 1);
    int p5 = raw.indexOf('|', p4 + 1);
    int p6 = raw.indexOf('|', p5 + 1);

    if (p1 < 0 || p2 < 0 || p3 < 0 || p4 < 0 || p5 < 0 || p6 < 0) {
      timetableCount = i;
      break;
    }

    timetable[i].id = raw.substring(0, p1).toInt();
    timetable[i].period = raw.substring(p1 + 1, p2).toInt();
    timetable[i].start = raw.substring(p2 + 1, p3);
    timetable[i].end = raw.substring(p3 + 1, p4);
    timetable[i].name = raw.substring(p4 + 1, p5);
    timetable[i].duration = raw.substring(p5 + 1, p6).toInt();
    timetable[i].enabled = raw.substring(p6 + 1).toInt() != 0;
  }

  Serial.printf("Timetable loaded: %d entries\n", timetableCount);
}

void saveTimetable() {
  timetablePrefs.putInt("count", timetableCount);
  timetablePrefs.putInt("nextId", nextTimetableId);

  for (int i = 0; i < timetableCount; i++) {
    String key = "e" + String(i);
    String raw = String(timetable[i].id) + "|" + String(timetable[i].period) +
                 "|" + timetable[i].start + "|" + timetable[i].end + "|" +
                 timetable[i].name + "|" + String(timetable[i].duration) + "|" +
                 (timetable[i].enabled ? "1" : "0");
    timetablePrefs.putString(key.c_str(), raw);
  }

  // Remove stale records after delete.
  for (int i = timetableCount; i < MAX_TIMETABLE_ENTRIES; i++) {
    String key = "e" + String(i);
    timetablePrefs.remove(key.c_str());
  }
}

int findTimetableIndexById(int id) {
  for (int i = 0; i < timetableCount; i++) {
    if (timetable[i].id == id)
      return i;
  }
  return -1;
}

String timetableEntryJSON(const TimetableEntry &e) {
  String json = "{";
  json += "\"id\":" + String(e.id) + ",";
  json += "\"period\":" + String(e.period) + ",";
  json += "\"start\":\"" + jsonEscape(e.start) + "\",";
  json += "\"end\":\"" + jsonEscape(e.end) + "\",";
  json += "\"name\":\"" + jsonEscape(e.name) + "\",";
  json += "\"duration\":" + String(e.duration) + ",";
  json += "\"enabled\":" + String(e.enabled ? "true" : "false");
  json += "}";
  return json;
}

void sendTimetableJSON() {
  // Simple insertion sort by period for stable dashboard ordering.
  int order[MAX_TIMETABLE_ENTRIES];
  for (int i = 0; i < timetableCount; i++)
    order[i] = i;
  for (int i = 1; i < timetableCount; i++) {
    int x = order[i];
    int j = i - 1;
    while (j >= 0 && timetable[order[j]].period > timetable[x].period) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = x;
  }

  String json = "[";
  for (int i = 0; i < timetableCount; i++) {
    if (i > 0)
      json += ",";
    json += timetableEntryJSON(timetable[order[i]]);
  }
  json += "]";
  sendJSON(200, json);
}

// =====================================================
// API TIMETABLE
// GET /api/timetable
// =====================================================
void handleTimetableGet() { sendTimetableJSON(); }

// =====================================================
// ADMIN AUTHORIZATION
// Any configuration-changing endpoint must pass this check.
// Reading status/timetable remains allowed without RFID.
// =====================================================
bool isAdminAuthenticated() { return rfidAuthenticated; }

bool requireAdminAuth() {
  if (isAdminAuthenticated())
    return true;

  sendJSON(403, "{\"success\":false,\"error\":\"RFID_AUTH_REQUIRED\","
                "\"message\":\"Valid admin RFID required for changes\"}");
  return false;
}

// =====================================================
// API TIMETABLE ADD
// POST /api/timetable
// =====================================================
void handleTimetablePost() {
  if (!requireAdminAuth())
    return;

  if (!server.hasArg("plain")) {
    sendJSON(400, "{\"success\":false,\"error\":\"Request body missing\"}");
    return;
  }

  if (timetableCount >= MAX_TIMETABLE_ENTRIES) {
    sendJSON(409, "{\"success\":false,\"error\":\"Timetable full\"}");
    return;
  }

  String body = server.arg("plain");
  TimetableEntry e;
  e.id = nextTimetableId++;
  e.period = fieldInt(body, "period", e.id);
  e.start = fieldString(body, "start", "");
  e.end = fieldString(body, "end", "");
  e.name = fieldString(body, "name", "");
  e.duration = fieldInt(body, "duration", 3);
  e.enabled = fieldBool(body, "enabled", true);

  if (!validTimeHHMM(e.start) || !validTimeHHMM(e.end) ||
      e.name.length() == 0) {
    sendJSON(400, "{\"success\":false,\"error\":\"Invalid timetable entry\"}");
    nextTimetableId--;
    return;
  }

  if (e.duration < 1)
    e.duration = 1;
  if (e.duration > 60)
    e.duration = 60;

  timetable[timetableCount++] = e;
  saveTimetable();

  String response =
      "{\"success\":true,\"entry\":" + timetableEntryJSON(e) + "}";
  sendJSON(201, response);
}

// =====================================================
// API TIMETABLE UPDATE / DELETE / TOGGLE
// Dynamic paths are handled through onNotFound(), e.g.
// /api/timetable/3 and /api/timetable/3/toggle
// =====================================================
void handleTimetableDynamic() {
  String uri = server.uri();
  const String prefix = "/api/timetable/";
  if (!uri.startsWith(prefix)) {
    sendJSON(404, "{\"error\":\"Endpoint not found\"}");
    return;
  }

  String rest = uri.substring(prefix.length());
  bool toggle = false;
  if (rest.endsWith("/toggle")) {
    toggle = true;
    rest = rest.substring(0, rest.length() - 7);
  }

  int id = rest.toInt();
  int idx = findTimetableIndexById(id);
  if (idx < 0) {
    sendJSON(404, "{\"success\":false,\"error\":\"Entry not found\"}");
    return;
  }

  // GET remains public; all write operations require valid admin RFID.
  if (server.method() != HTTP_GET && !requireAdminAuth())
    return;

  if (toggle && server.method() == HTTP_PUT) {
    timetable[idx].enabled = !timetable[idx].enabled;
    saveTimetable();
    String response = "{\"success\":true,\"enabled\":" +
                      String(timetable[idx].enabled ? "true" : "false") + "}";
    sendJSON(200, response);
    return;
  }

  if (server.method() == HTTP_DELETE) {
    for (int i = idx; i < timetableCount - 1; i++)
      timetable[i] = timetable[i + 1];
    timetableCount--;
    saveTimetable();
    sendJSON(200, "{\"success\":true}");
    return;
  }

  if (server.method() == HTTP_PUT) {
    if (!server.hasArg("plain")) {
      sendJSON(400, "{\"success\":false,\"error\":\"Request body missing\"}");
      return;
    }

    String body = server.arg("plain");
    String start = fieldString(body, "start", timetable[idx].start);
    String end = fieldString(body, "end", timetable[idx].end);
    String name = fieldString(body, "name", timetable[idx].name);
    int period = fieldInt(body, "period", timetable[idx].period);
    int duration = fieldInt(body, "duration", timetable[idx].duration);
    bool enabled = fieldBool(body, "enabled", timetable[idx].enabled);

    if (!validTimeHHMM(start) || !validTimeHHMM(end) || name.length() == 0) {
      sendJSON(400,
               "{\"success\":false,\"error\":\"Invalid timetable entry\"}");
      return;
    }

    if (duration < 1)
      duration = 1;
    if (duration > 60)
      duration = 60;

    timetable[idx].period = period;
    timetable[idx].start = start;
    timetable[idx].end = end;
    timetable[idx].name = name;
    timetable[idx].duration = duration;
    timetable[idx].enabled = enabled;
    saveTimetable();

    String response =
        "{\"success\":true,\"entry\":" + timetableEntryJSON(timetable[idx]) +
        "}";
    sendJSON(200, response);
    return;
  }

  sendJSON(405, "{\"success\":false,\"error\":\"Method not allowed\"}");
}

// =====================================================
// AUTOMATIC BELL
// Dashboard timetable is the only source of automatic times.
// No timetable times are hard-coded in firmware.
// =====================================================
void checkAutomaticBell() {
  if (bellActive || timetableCount == 0)
    return;

  time_t now = time(nullptr);
  if (now < 1700000000)
    return;

  struct tm timeinfo;
  if (!localtime_r(&now, &timeinfo))
    return;

  char hhmm[6];
  snprintf(hhmm, sizeof(hhmm), "%02d:%02d", timeinfo.tm_hour, timeinfo.tm_min);

  char dateKey[16];
  snprintf(dateKey, sizeof(dateKey), "%04d-%02d-%02d", timeinfo.tm_year + 1900,
           timeinfo.tm_mon + 1, timeinfo.tm_mday);

  // Only trigger near the start of the minute. This prevents a newly
  // uploaded timetable from ringing late in an already-running minute.
  if (timeinfo.tm_sec > 2)
    return;

  for (int i = 0; i < timetableCount; i++) {
    if (!timetable[i].enabled)
      continue;
    if (timetable[i].start != String(hhmm))
      continue;

    String key = String(dateKey) + ":" + String(timetable[i].id);
    if (key == lastAutoBellKey)
      return;

    lastAutoBellKey = key;
    unsigned long seconds = (unsigned long)timetable[i].duration;
    if (seconds < 1)
      seconds = 1;
    if (seconds > 60)
      seconds = 60;
    bellDuration = seconds * 1000UL;
    startBell(false);

    Serial.print("AUTOMATIC TIMETABLE BELL -> ");
    Serial.print(timetable[i].name);
    Serial.print(" at ");
    Serial.println(timetable[i].start);
    return;
  }
}

// =====================================================
// API STATUS
// GET /api/status
// =====================================================
void handleStatus() {

  unsigned long remaining = 0;

  if (bellActive) {

    unsigned long elapsed = millis() - bellStartTime;

    if (elapsed < bellDuration) {

      remaining = bellDuration - elapsed;
    }
  }

  int countdownSeconds = (remaining + 999) / 1000;

  String json = "{";

  json += "\"online\":true,";

  json += "\"wifi\":";
  json += WiFi.status() == WL_CONNECTED ? "true," : "false,";

  json += "\"ip\":\"";
  json += WiFi.localIP().toString();
  json += "\",";

  json += "\"bellActive\":";
  json += bellActive ? "true," : "false,";

  json += "\"bellIsEmergency\":";
  json += bellIsEmergency ? "true," : "false,";

  json += "\"bellDuration\":";
  json += String(bellDuration / 1000);
  json += ",";

  json += "\"bellCountdown\":";
  json += String(countdownSeconds);
  json += ",";

  json += "\"rfidUnlocked\":";
  json += rfidAuthenticated ? "true," : "false,";

  json += "\"rtcSynced\":";
  json += isRTCValid() ? "true," : "false,";

  json += "\"time\":\"";
  json += getTimeString();
  json += "\",";

  json += "\"date\":\"";
  json += getDateString();
  json += "\",";

  json += "\"touch\":";
  json += digitalRead(TTP223_PIN) ? "true," : "false,";

  json += "\"emergencyButton\":";
  json += digitalRead(EMERGENCY_PIN) == LOW ? "true" : "false";

  json += "}";

  sendJSON(200, json);
}

// =====================================================
// API AUTH STATUS
// GET /api/auth
// =====================================================
void handleAuthStatus() {

  String json = "{";

  json += "\"rfidAuthenticated\":";
  json += rfidAuthenticated ? "true," : "false,";

  json += "\"touchEnabled\":";
  json += touchEnabled ? "true," : "false,";

  json += "\"touchLocked\":";
  json += touchLocked ? "true," : "false,";

  json += "\"manualBellLocked\":";
  json += manualBellLocked ? "true," : "false,";

  json += "\"emergencyReady\":true,";

  json += "\"lastRfidUid\":\"";
  json += lastRfidUid;
  json += "\"";

  json += "}";

  sendJSON(200, json);
}

// =====================================================
// API RFID AUTH
// POST /api/auth/rfid
// {"uid":"17:F1:74:06"}
// =====================================================
void handleRFIDAuth() {

  if (!server.hasArg("plain")) {

    sendJSON(400, "{\"success\":false,\"message\":\"UID missing\"}");

    return;
  }

  String body = server.arg("plain");

  int pos = body.indexOf("\"uid\"");

  if (pos < 0) {

    sendJSON(400, "{\"success\":false,\"message\":\"UID missing\"}");

    return;
  }

  int colon = body.indexOf(":", pos);

  int firstQuote = body.indexOf("\"", colon + 1);

  int secondQuote = body.indexOf("\"", firstQuote + 1);

  if (firstQuote < 0 || secondQuote < 0) {

    sendJSON(400, "{\"success\":false,\"message\":\"Invalid UID\"}");

    return;
  }

  String uid = body.substring(firstQuote + 1, secondQuote);

  uid.toUpperCase();

  if (uid == ADMIN_UID) {

    unlockByRFID(uid);

    sendJSON(200, "{\"success\":true,\"authenticated\":true,\"message\":\"RFID "
                  "authorized\"}");

  } else {

    lastRfidUid = uid;

    lockAuthentication();

    sendJSON(403, "{\"success\":false,\"authenticated\":false,\"message\":"
                  "\"Unauthorized RFID\"}");
  }
}

// =====================================================
// API LOCK
// POST /api/auth/lock
// =====================================================
void handleAuthLock() {

  lockAuthentication();

  sendJSON(200, "{\"success\":true,\"locked\":true}");
}

// =====================================================
// API MANUAL BELL
// POST /api/bell/manual
// =====================================================
void handleManualBell() {

  bellDuration = 3000;

  if (!rfidAuthenticated || !touchEnabled || touchLocked) {

    sendJSON(403, "{\"success\":false,\"authorized\":false,\"message\":\"RFID "
                  "authorization required\"}");

    return;
  }

  startBell(false);

  // One-use authorization
  lockAuthentication();

  sendJSON(200, "{\"success\":true,\"bellActive\":true,\"message\":\"Manual "
                "bell started\"}");
}

// =====================================================
// API EMERGENCY
// POST /api/bell/emergency
// =====================================================
void handleEmergencyBell() {

  bellDuration = 3000;
  startBell(true);

  sendJSON(200, "{\"success\":true,\"bellActive\":true,\"emergency\":true}");
}

// =====================================================
// OLD API ALIASES
// =====================================================
void handleBellAlias() { handleManualBell(); }

void handleEmergencyAlias() { handleEmergencyBell(); }

void handleLockAlias() { handleAuthLock(); }

// =====================================================
// CORS OPTIONS
// =====================================================
void handleOptions() {

  addCORS();

  server.send(204, "text/plain", "");
}

// =====================================================
// 404
// =====================================================
void handleNotFound() {
  if (server.uri().startsWith("/api/timetable/")) {
    if (server.method() == HTTP_OPTIONS) {
      handleOptions();
      return;
    }
    handleTimetableDynamic();
    return;
  }

  sendJSON(404, "{\"error\":\"Endpoint not found\"}");
}

// =====================================================
// RFID CHECK
// =====================================================
void checkRFID() {

  if (!rfid.PICC_IsNewCardPresent()) {
    return;
  }

  if (!rfid.PICC_ReadCardSerial()) {
    return;
  }

  String uid = getUIDString();

  Serial.print("RFID detected: ");

  Serial.println(uid);

  unlockByRFID(uid);

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// =====================================================
// TOUCH CHECK
// =====================================================
void checkTouch() {

  bool touchState = digitalRead(TTP223_PIN);

  if (touchState && !lastTouchState) {

    Serial.println("Touch detected");

    if (rfidAuthenticated && touchEnabled && !touchLocked) {

      Serial.println("Touch authorized -> Bell");

      bellDuration = 3000;
      startBell(false);

      // One touch = one bell
      lockAuthentication();

    } else {

      Serial.println("Touch ignored - RFID required");
    }
  }

  lastTouchState = touchState;
}

// =====================================================
// EMERGENCY CHECK
// =====================================================
void checkEmergency() {

  bool emergencyState = digitalRead(EMERGENCY_PIN);

  if (emergencyState == LOW && lastEmergencyState == HIGH) {

    Serial.println("!!! EMERGENCY BUTTON !!!");

    bellDuration = 3000;
    startBell(true);
  }

  lastEmergencyState = emergencyState;
}

// =====================================================
// WIFI RECONNECT
// =====================================================
void checkWiFi() {

  if (millis() - lastWiFiCheck < 10000) {
    return;
  }

  lastWiFiCheck = millis();

  if (WiFi.status() != WL_CONNECTED) {

    Serial.println("WiFi disconnected. Reconnecting...");

    WiFi.disconnect();

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// =====================================================
// NTP / RTC MANAGEMENT
// =====================================================
void updateClock() {

  // ---------------------------------------------------
  // Wi-Fi connected: NTP has priority.
  // Do NOT load the old RTC value while waiting for NTP,
  // because an invalid RTC value such as 2038 can overwrite
  // the ESP32 system clock.
  // ---------------------------------------------------
  if (WiFi.status() == WL_CONNECTED && !ntpSyncDone) {

    if (millis() - lastNTPSync >= 2000) {

      lastNTPSync = millis();

      if (syncRTCFromNTP()) {
        ntpSyncDone = true;
      }
    }

    return;
  }

  // ---------------------------------------------------
  // Wi-Fi is unavailable: use a valid PCF8563 clock.
  // ---------------------------------------------------
  if (WiFi.status() != WL_CONNECTED && rtcAvailable) {

    static unsigned long lastRTCLoad = 0;

    if (millis() - lastRTCLoad >= 10000) {

      lastRTCLoad = millis();

      if (isRTCValid()) {
        syncSystemTimeFromRTC();
      }
    }
  }
}
// =====================================================
// SETUP
// =====================================================
void setup() {

  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("======================================");
  Serial.println(" ADVANCED SMART SCHOOL BELL ESP32");
  Serial.println("======================================");

  // ===================================================
  // GPIO
  // ===================================================
  pinMode(TTP223_PIN, INPUT);

  pinMode(EMERGENCY_PIN, INPUT_PULLUP);

  pinMode(BUZZER_PIN, OUTPUT);

  pinMode(GREEN_LED, OUTPUT);

  pinMode(RED_LED, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);

  digitalWrite(RED_LED, LOW);

  digitalWrite(GREEN_LED, HIGH);

  // ===================================================
  // I2C
  // ===================================================
  Wire.begin(I2C_SDA, I2C_SCL);

  Wire.setClock(100000);

  // ===================================================
  // TIMETABLE STORAGE
  // ===================================================
  timetablePrefs.begin("timetable", false);
  loadTimetable();

  Serial.println("I2C started");

  // ===================================================
  // PCF8563 DETECTION
  // ===================================================
  Wire.beginTransmission(PCF8563_ADDR);

  if (Wire.endTransmission() == 0) {

    rtcAvailable = true;

    Serial.println("PCF8563 RTC detected at 0x51");

  } else {

    rtcAvailable = false;

    Serial.println("ERROR: PCF8563 RTC NOT FOUND");
  }

  // ===================================================
  // RFID
  // ===================================================
  SPI.begin(RFID_SCK, RFID_MISO, RFID_MOSI, RFID_SS);

  rfid.PCD_Init();

  delay(50);

  Serial.println("RFID OK");

  // ===================================================
  // WIFI
  // ===================================================
  WiFi.mode(WIFI_STA);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting WiFi");

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 30) {

    delay(500);

    Serial.print(".");

    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {

    Serial.println("WiFi connected");

    Serial.print("ESP32 IP: ");

    Serial.println(WiFi.localIP());

    // =================================================
    // NTP
    // =================================================
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "pool.ntp.org",
               "time.nist.gov");

    Serial.println("NTP started");

  } else {

    Serial.println("WiFi connection FAILED");

    // Try existing RTC
    if (isRTCValid()) {

      syncSystemTimeFromRTC();

      Serial.println("Using PCF8563 offline time.");
    }
  }

  // ===================================================
  // API ROUTES
  // ===================================================

  // STATUS
  server.on("/api/status", HTTP_GET, handleStatus);

  // AUTH STATUS
  server.on("/api/auth", HTTP_GET, handleAuthStatus);

  // RFID AUTH
  server.on("/api/auth/rfid", HTTP_POST, handleRFIDAuth);

  // LOCK
  server.on("/api/auth/lock", HTTP_POST, handleAuthLock);

  // MANUAL BELL
  server.on("/api/bell/manual", HTTP_POST, handleManualBell);

  // EMERGENCY
  server.on("/api/bell/emergency", HTTP_POST, handleEmergencyBell);

  // TIMETABLE
  server.on("/api/timetable", HTTP_GET, handleTimetableGet);

  server.on("/api/timetable", HTTP_POST, handleTimetablePost);

  // TIMETABLE OPTIONS
  server.on("/api/timetable", HTTP_OPTIONS, handleOptions);

  // OLD ALIASES
  server.on("/api/bell", HTTP_POST, handleBellAlias);

  server.on("/api/emergency", HTTP_POST, handleEmergencyAlias);

  server.on("/api/lock", HTTP_POST, handleLockAlias);

  // ===================================================
  // OPTIONS
  // ===================================================

  server.on("/api/status", HTTP_OPTIONS, handleOptions);

  server.on("/api/auth", HTTP_OPTIONS, handleOptions);

  server.on("/api/auth/rfid", HTTP_OPTIONS, handleOptions);

  server.on("/api/auth/lock", HTTP_OPTIONS, handleOptions);

  server.on("/api/bell/manual", HTTP_OPTIONS, handleOptions);

  server.on("/api/bell/emergency", HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);

  // ===================================================
  // START SERVER
  // ===================================================
  server.begin();

  Serial.println("HTTP server started");

  Serial.println();
}

// =====================================================
// LOOP
// =====================================================
void loop() {

  // Web API
  server.handleClient();

  // WiFi
  checkWiFi();

  // Clock
  updateClock();

  // Hardware
  checkRFID();

  checkTouch();

  checkEmergency();

  // Dashboard-driven automatic timetable bell
  checkAutomaticBell();

  // Bell timer
  updateBell();

  delay(5);
}