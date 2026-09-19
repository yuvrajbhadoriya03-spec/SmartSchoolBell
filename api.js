/* ═══════════════════════════════════════════════════════
   SMART SCHOOL BELL
   API LAYER – REAL ESP32 INTEGRATION
   ═══════════════════════════════════════════════════════ */

const API = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════════
  // ESP32 CONFIGURATION
  // ═══════════════════════════════════════════════════════

  const BASE_URL = 'http://10.225.96.148';

  const RFID_ADMIN_UID = '17:F1:74:06';

  // Default local fallback values
  const DEFAULT_BELL_DURATION = 3;
  const DEFAULT_EMERGENCY_DURATION = 3;

  // ═══════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════

  async function request(endpoint, options = {}) {
    const url = `${BASE_URL}${endpoint}`;

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });

      const text = await response.text();
      let parsed = null;

      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { data: text };
        }
      }

      if (!response.ok) {
        const errMsg = parsed?.message || parsed?.error || `HTTP ${response.status}`;
        const err = new Error(errMsg);
        err.status = response.status;
        err.data = parsed;
        throw err;
      }

      return parsed ?? { success: true };

    } catch (error) {
      console.error(`ESP32 API error: ${endpoint}`, error);

      throw error;
    }
  }

  function handleApiError(error) {
    if (error && error.data && typeof error.data === 'object') {
      return {
        success: false,
        error: error.data.error || `HTTP_${error.status || 500}`,
        message: error.data.message || error.message || 'ESP32 request rejected',
        ...error.data
      };
    }
    return {
      success: false,
      error: 'ESP32_OFFLINE',
      message: 'ESP32 is not reachable'
    };
  }

  async function safeRequest(endpoint, options = {}, fallback = null) {
    try {
      return await request(endpoint, options);
    } catch (error) {
      console.error(`ESP32 request failed: ${endpoint}`, error);
      return fallback;
    }
  }

  function jsonBody(data) {
    return {
      method: 'POST',
      body: JSON.stringify(data)
    };
  }

  function putJsonBody(data) {
    return {
      method: 'PUT',
      body: JSON.stringify(data)
    };
  }

  // ═══════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════

  return {

    // ═══════════════════════════════════════════════════
    // GET SYSTEM STATUS
    // ESP32: GET /api/status
    // ═══════════════════════════════════════════════════

    async getStatus() {

      const fallback = {
        online: false,
        wifi: false,
        ip: '',
        rtcSynced: false,

        time: '--:--:--',
        date: '--/--/----',

        bellActive: false,
        bellIsEmergency: false,
        bellDuration: DEFAULT_BELL_DURATION,
        bellCountdown: 0,

        rfidUnlocked: false,
        touch: false,
        emergencyButton: false
      };

      const data = await safeRequest(
        '/api/status',
        {
          method: 'GET'
        },
        null
      );

      if (!data) {
        return fallback;
      }

      return {
        online: data.online ?? true,
        wifi: data.wifi ?? false,

        ip: data.ip ?? BASE_URL.replace('http://', ''),

        rtcSynced: data.rtcSynced ?? false,

        time: data.time ?? '--:--:--',
        date: data.date ?? '--/--/----',

        bellActive: data.bellActive ?? false,
        bellIsEmergency: data.bellIsEmergency ?? false,

        bellDuration:
          Number(data.bellDuration ?? DEFAULT_BELL_DURATION),

        bellCountdown:
          Number(data.bellCountdown ?? 0),

        rfidUnlocked:
          data.rfidUnlocked ?? false,

        touch:
          data.touch ?? false,

        emergencyButton:
          data.emergencyButton ?? false
      };
    },


    // ═══════════════════════════════════════════════════
    // GET AUTH STATUS
    // ESP32: GET /api/auth
    // ═══════════════════════════════════════════════════

    async getAuthStatus() {

      const fallback = {
        rfidAuthenticated: false,
        touchEnabled: false,
        touchLocked: true,
        manualBellLocked: true,
        emergencyReady: true,
        lastRfidUid: null
      };

      const data = await safeRequest(
        '/api/auth',
        {
          method: 'GET'
        },
        null
      );

      if (!data) {
        return fallback;
      }

      return {
        rfidAuthenticated:
          data.rfidAuthenticated ??
          data.rfidUnlocked ??
          false,

        touchEnabled:
          data.touchEnabled ??
          false,

        touchLocked:
          data.touchLocked ??
          !(
            data.touchEnabled ??
            false
          ),

        manualBellLocked:
          data.manualBellLocked ??
          !(
            data.rfidAuthenticated ??
            data.rfidUnlocked ??
            false
          ),

        emergencyReady:
          data.emergencyReady ??
          true,

        lastRfidUid:
          data.lastRfidUid ??
          null
      };
    },


    // ═══════════════════════════════════════════════════
    // MANUAL BELL
    // ESP32: POST /api/bell/manual
    // ═══════════════════════════════════════════════════

    async triggerManualBell() {

      try {

        const result = await request(
          '/api/bell/manual',
          {
            method: 'POST'
          }
        );

        return {
          success: result.success ?? true,
          duration:
            Number(
              result.duration ??
              DEFAULT_BELL_DURATION
            ),

          error:
            result.error ?? null,

          message:
            result.message ?? ''
        };

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // EMERGENCY BELL
    // ESP32: POST /api/bell/emergency
    // ═══════════════════════════════════════════════════

    async triggerEmergencyBell() {

      try {

        const result = await request(
          '/api/bell/emergency',
          {
            method: 'POST'
          }
        );

        return {
          success: result.success ?? true,

          duration:
            Number(
              result.duration ??
              DEFAULT_EMERGENCY_DURATION
            ),

          error:
            result.error ?? null,

          message:
            result.message ?? ''
        };

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // GENERIC BELL
    // ESP32: POST /api/bell
    // ═══════════════════════════════════════════════════

    async triggerBell() {

      try {

        const result = await request(
          '/api/bell',
          {
            method: 'POST'
          }
        );

        return {
          success: result.success ?? true,
          duration:
            Number(
              result.duration ??
              DEFAULT_BELL_DURATION
            ),

          error:
            result.error ?? null,

          message:
            result.message ?? ''
        };

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // EMERGENCY ALIAS
    // ESP32: POST /api/emergency
    // ═══════════════════════════════════════════════════

    async triggerEmergency() {
      return this.triggerEmergencyBell();
    },


    // ═══════════════════════════════════════════════════
    // LOCK / LOGOUT
    // ESP32: POST /api/auth/lock
    // ═══════════════════════════════════════════════════

    async lockAuth() {

      try {

        const result = await request(
          '/api/auth/lock',
          {
            method: 'POST'
          }
        );

        return {
          success: result.success ?? true
        };

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // LOCK ALIAS
    // ESP32: POST /api/lock
    // ═══════════════════════════════════════════════════

    async lock() {
      return this.lockAuth();
    },


    // ═══════════════════════════════════════════════════
    // RFID AUTHENTICATION
    // ESP32: POST /api/auth/rfid
    // ═══════════════════════════════════════════════════

    async authenticateRFID(scannedUid) {

      const uid =
        String(
          scannedUid ||
          RFID_ADMIN_UID
        )
          .trim()
          .toUpperCase();

      try {

        const result = await request(
          '/api/auth/rfid',
          {
            method: 'POST',
            body: JSON.stringify({
              uid: uid
            })
          }
        );

        return {
          success:
            result.success ?? false,

          user:
            result.user ??
            (result.success ? 'Admin' : null),

          uid:
            result.uid ??
            uid,

          error:
            result.error ?? null,

          message:
            result.message ?? ''
        };

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // CHECK MANUAL BELL LOCK
    // ═══════════════════════════════════════════════════

    async isManualBellLocked() {

      const auth =
        await this.getAuthStatus();

      return auth.manualBellLocked;
    },


    // ═══════════════════════════════════════════════════
    // BELL STATE
    // Derived from live ESP32 status
    // ═══════════════════════════════════════════════════

    async getBellState() {

      const status =
        await this.getStatus();

      return {
        active:
          status.bellActive,

        isEmergency:
          status.bellIsEmergency,

        duration:
          status.bellDuration,

        countdown:
          status.bellCountdown
      };
    },


    // ═══════════════════════════════════════════════════
    // STOP BELL
    //
    // NOTE:
    // Current ESP32 API does not expose a dedicated
    // /api/bell/stop endpoint.
    //
    // Therefore this function does NOT fake-stop the
    // hardware bell.
    // ═══════════════════════════════════════════════════

    async stopBell() {

      console.warn(
        'ESP32 does not currently provide /api/bell/stop'
      );

      return {
        success: false,
        error: 'STOP_ENDPOINT_NOT_AVAILABLE',
        message:
          'ESP32 stop-bell endpoint is not implemented'
      };
    },


    // ═══════════════════════════════════════════════════
    // COUNTDOWN
    //
    // Countdown comes directly from ESP32.
    // No local mock countdown is used.
    // ═══════════════════════════════════════════════════

    async tickBellCountdown() {

      const status =
        await this.getStatus();

      return status.bellCountdown;
    },


    // ═══════════════════════════════════════════════════
    // TIMETABLE
    // ═══════════════════════════════════════════════════

    async getTimetable() {

      const result =
        await safeRequest(
          '/api/timetable',
          {
            method: 'GET'
          },
          null
        );

      if (!result) {
        return [];
      }

      const entries =
        Array.isArray(result)
          ? result
          : (
            Array.isArray(result.timetable)
              ? result.timetable
              : (
                Array.isArray(result.entries)
                  ? result.entries
                  : []
              )
          );

      return [...entries].sort(
        (a, b) =>
          Number(a.period ?? 0) -
          Number(b.period ?? 0)
      );
    },


    // ═══════════════════════════════════════════════════
    // ADD TIMETABLE ENTRY
    // ESP32: POST /api/timetable
    // ═══════════════════════════════════════════════════

    async addEntry(entry) {

      try {

        const result =
          await request(
            '/api/timetable',
            {
              method: 'POST',
              body: JSON.stringify(entry)
            }
          );

        return result;

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // UPDATE TIMETABLE ENTRY
    // ESP32: PUT /api/timetable/:id
    // ═══════════════════════════════════════════════════

    async updateEntry(id, updates) {

      try {

        const result =
          await request(
            `/api/timetable/${encodeURIComponent(id)}`,
            {
              method: 'PUT',
              body: JSON.stringify(updates)
            }
          );

        return result;

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // DELETE TIMETABLE ENTRY
    // ESP32: DELETE /api/timetable/:id
    // ═══════════════════════════════════════════════════

    async deleteEntry(id) {

      try {

        const result =
          await request(
            `/api/timetable/${encodeURIComponent(id)}`,
            {
              method: 'DELETE'
            }
          );

        return result;

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // ENABLE / DISABLE TIMETABLE ENTRY
    // ESP32: PUT /api/timetable/:id/toggle
    // ═══════════════════════════════════════════════════

    async toggleEntry(id) {

      try {

        const result =
          await request(
            `/api/timetable/${encodeURIComponent(id)}/toggle`,
            {
              method: 'PUT'
            }
          );

        return result;

      } catch (error) {
        return handleApiError(error);
      }
    },


    // ═══════════════════════════════════════════════════
    // MODES
    // ═══════════════════════════════════════════════════

    async getModes() {

      const result =
        await safeRequest(
          '/api/modes',
          {
            method: 'GET'
          },
          null
        );

      if (!result) {
        return {
          holiday: false,
          exam: false,
          special: false,
          normal: true,
          auto: true
        };
      }

      return result.modes ?? result;
    },


    // ═══════════════════════════════════════════════════
    // SET MODE
    // ESP32: PUT /api/modes
    // ═══════════════════════════════════════════════════

    async setMode(mode, value) {

      try {

        const result =
          await request(
            '/api/modes',
            {
              method: 'PUT',
              body: JSON.stringify({
                [mode]: Boolean(value)
              })
            }
          );

        return result;

      } catch (error) {
        return handleApiError(error);
      }
    }

  };

})();