/* ═══════════════════════════════════════════════════════
   APP – Main Application Logic
   Smart School Bell IoT Control System
   ═══════════════════════════════════════════════════════ */

const App = (() => {
  'use strict';

  // ─── STATE ───
  let isAuthenticated = false;
  let bellTimer = null;
  let editingEntryId = null;

  // ─── DOM CACHE ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ═══════════ INITIALIZATION ═══════════
  function init() {
    initParticles();
    startClock();
    loadTimetable();
    loadManagerTable();
    startNextBellCountdown();
    updateManualBellUI();

    // Poll ESP32 system status every 500ms
    // This prevents missing the 3-second bell state.
    setInterval(updateSystemStatus, 500);

    updateSystemStatus();
  }

  // ═══════════ PARTICLES ═══════════
  function initParticles() {
    const canvas = $('#particleCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let particles = [];
    let w, h;

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }

    window.addEventListener('resize', resize);
    resize();

    const PARTICLE_COUNT = Math.min(
      60,
      Math.floor(w * h / 20000)
    );

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.3 + 0.05,
      });
    }

    function animate() {
      ctx.clearRect(0, 0, w, h);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle =
          `rgba(59, 130, 246, ${p.alpha})`;
        ctx.fill();
      });

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 150) {
            ctx.beginPath();
            ctx.moveTo(
              particles[i].x,
              particles[i].y
            );
            ctx.lineTo(
              particles[j].x,
              particles[j].y
            );
            ctx.strokeStyle =
              `rgba(59, 130, 246, ${0.04 * (1 - dist / 150)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(animate);
    }

    animate();
  }

  // ═══════════ CLOCK ═══════════
  let rtcOffsetMs = null;

  function syncRtcClock(timeStr, dateStr) {
    if (!timeStr || timeStr === '--:--:--') return;
    try {
      let targetMs;
      if (dateStr && dateStr !== '--/--/----' && dateStr.includes('-')) {
        targetMs = new Date(`${dateStr}T${timeStr}`).getTime();
      } else {
        const [h, m, s] = timeStr.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, s, 0);
        targetMs = d.getTime();
      }
      if (!isNaN(targetMs)) {
        rtcOffsetMs = targetMs - Date.now();
      }
    } catch {
      // fallback to browser time
    }
  }

  function startClock() {
    function updateClock() {
      const now = (rtcOffsetMs !== null) ? new Date(Date.now() + rtcOffsetMs) : new Date();

      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      const period = hours >= 12 ? 'PM' : 'AM';

      const displayHours = hours % 12 || 12;

      const clockDisplay = $('#clockDisplay');
      const clockPeriod = $('#clockPeriod');
      const liveDate = $('#liveDate');

      if (clockDisplay) {
        clockDisplay.textContent =
          `${String(displayHours).padStart(2, '0')}:${minutes}:${seconds}`;
      }

      if (clockPeriod) {
        clockPeriod.textContent = period;
      }

      if (liveDate) {
        const options = {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        };

        liveDate.textContent =
          now.toLocaleDateString('en-US', options);
      }
    }

    updateClock();
    setInterval(updateClock, 1000);
  }

  // ═══════════ SYSTEM STATUS ═══════════
  async function updateSystemStatus() {
    try {
      const status = await API.getStatus();
      const auth = await API.getAuthStatus();

      // ─── Wi-Fi ───
      const wifiEl = $('#wifiStatus');

      if (wifiEl) {
        wifiEl.innerHTML = status.wifi
          ? '<span class="status-dot dot-ok"></span>Connected'
          : '<span class="status-dot dot-error"></span>Disconnected';
      }

      // ─── System ───
      const sysEl = $('#systemStatus');

      if (sysEl) {
        sysEl.innerHTML = status.online
          ? '<span class="status-dot dot-ok"></span>Online'
          : '<span class="status-dot dot-error"></span>Offline';
      }

      // ─── System Badge ───
      const badge = $('#systemStatusBadge');

      if (badge) {
        badge.textContent =
          status.online ? 'ONLINE' : 'OFFLINE';

        badge.className =
          `card-badge ${status.online
            ? 'badge-online'
            : 'badge-offline'
          }`;
      }

      // ═══════════ BELL STATUS ═══════════
      const bellEl = $('#bellOnOff');

      if (bellEl) {
        if (status.bellActive) {

          if (status.bellIsEmergency) {
            bellEl.innerHTML =
              '<span class="status-dot dot-error"></span>EMERGENCY';
          } else {
            bellEl.innerHTML =
              '<span class="status-dot dot-warn"></span>Ringing';
          }

        } else {
          bellEl.innerHTML =
            '<span class="status-dot dot-idle"></span>Idle';
        }
      }

      // ─── Connection Badge ───
      const connBadge = $('#connectionBadge');
      if (connBadge) {
        const connText = connBadge.querySelector('.conn-text');
        if (status.online) {
          connBadge.style.borderColor = 'rgba(16,185,129,0.25)';
          connBadge.style.background = 'rgba(16,185,129,0.1)';
          connBadge.style.color = 'var(--green)';
          if (connText) connText.textContent = 'ESP32 CONNECTED';
        } else {
          connBadge.style.borderColor = 'rgba(239,68,68,0.25)';
          connBadge.style.background = 'rgba(239,68,68,0.1)';
          connBadge.style.color = 'var(--red)';
          if (connText) connText.textContent = 'ESP32 OFFLINE';
        }
      }

      // ─── RTC Sync ───
      const rtcEl = $('#rtcSync');
      if (rtcEl) {
        rtcEl.innerHTML = status.rtcSynced
          ? '<span class="status-dot dot-ok"></span>Synced'
          : '<span class="status-dot dot-warn"></span>Not Synced';
      }

      // ─── Live Clock RTC Sync ───
      if (status.time && status.rtcSynced) {
        syncRtcClock(status.time, status.date);
      }

      // ─── System Information Live Card ───
      const sysEsp32 = $('#sysEsp32');
      const sysEsp32IP = $('#sysEsp32IP');
      if (sysEsp32) {
        sysEsp32.textContent = status.online ? 'Connected via Wi-Fi' : 'Disconnected';
      }
      if (sysEsp32IP && status.ip) {
        sysEsp32IP.textContent = `IP: ${status.ip}`;
      }
      const sysRTC = $('#sysRTC');
      if (sysRTC) {
        sysRTC.textContent = status.rtcSynced ? 'PCF8563 – Synchronized' : 'PCF8563 – Offline/Unsynced';
      }

      // ─── Security ───
      updateSecurityUI(auth);

      // ─── Manual Bell Lock ───
      await updateManualBellUI();

      // ─── Sync active bell banner with ESP32 ───
      syncBellBanner(status);

    } catch (e) {
      console.error(
        'Status update failed:',
        e
      );
    }
  }

  // ═══════════ BELL BANNER SYNC ═══════════
  function syncBellBanner(status) {
    if (!status) return;

    if (status.bellActive) {
      showBellActive(
        Boolean(status.bellIsEmergency)
      );

      if (
        typeof status.bellCountdown === 'number' &&
        status.bellCountdown > 0
      ) {
        $('#bellCountdown').textContent =
          `${status.bellCountdown}s`;
      }

    } else {
      const banner = $('#bellActiveBanner');

      if (
        banner &&
        banner.classList.contains('visible')
      ) {
        hideBellActive(false);
      }
    }
  }

  // ═══════════ SECURITY UI ═══════════
  function updateSecurityUI(auth) {
    if (!auth) return;

    // ─── RFID ───
    const rfidIcon = $('#secRFID .sec-icon');
    const rfidVal = $('#secRFIDVal');

    if (rfidIcon && rfidVal) {
      if (auth.rfidAuthenticated) {
        rfidIcon.className =
          'sec-icon sec-ok';

        rfidVal.textContent =
          'Authenticated';

        rfidVal.className =
          'sec-value sec-val-ok';
      } else {
        rfidIcon.className =
          'sec-icon sec-locked';

        rfidVal.textContent =
          'Not Authenticated';

        rfidVal.className =
          'sec-value sec-val-locked';
      }
    }

    // ─── Access ───
    const accessIcon = $('#secAccess .sec-icon');
    const accessVal = $('#secAccessVal');

    if (accessIcon && accessVal) {
      if (auth.rfidAuthenticated) {
        accessIcon.className =
          'sec-icon sec-ok';

        accessVal.textContent =
          'Authorized';

        accessVal.className =
          'sec-value sec-val-ok';
      } else {
        accessIcon.className =
          'sec-icon sec-locked';

        accessVal.textContent =
          'Locked';

        accessVal.className =
          'sec-value sec-val-locked';
      }
    }

    // ─── Touch ───
    const touchIcon = $('#secTouch .sec-icon');
    const touchVal = $('#secTouchVal');

    if (touchIcon && touchVal) {
      if (
        auth.touchEnabled &&
        !auth.touchLocked
      ) {
        touchIcon.className =
          'sec-icon sec-ok';

        touchVal.textContent =
          'Enabled';

        touchVal.className =
          'sec-value sec-val-ok';
      } else {
        touchIcon.className =
          'sec-icon sec-locked';

        touchVal.textContent =
          auth.touchLocked
            ? 'Locked (Scan RFID)'
            : 'Disabled';

        touchVal.className =
          'sec-value sec-val-locked';
      }
    }

    // ─── Admin Badge ───
    const adminBadge = $('#adminBadge');

    if (adminBadge) {
      const span =
        adminBadge.querySelector('span');

      if (auth.rfidAuthenticated) {
        adminBadge.className =
          'admin-badge admin-authed';

        if (span) {
          span.textContent = 'AUTHORIZED';
        }
      } else {
        adminBadge.className =
          'admin-badge';

        if (span) {
          span.textContent = 'LOCKED';
        }
      }
    }
  }

  // ═══════════ BELL CONTROL ═══════════

  async function updateManualBellUI() {
    const btn = $('#btnManualBell');

    if (!btn) return;

    const isLocked =
      await API.isManualBellLocked();

    const span = btn.querySelector('span');

    if (isLocked) {
      btn.classList.add('btn-locked');

      if (span) {
        span.textContent =
          'RFID AUTH REQUIRED';
      }

      btn.title =
        'Scan admin RFID card to unlock manual bell';

    } else {
      btn.classList.remove('btn-locked');

      if (span) {
        span.textContent =
          'MANUAL BELL';
      }

      btn.title =
        'Touch to ring bell (one-time use, re-scan RFID after)';
    }
  }

  // ═══════════ MANUAL BELL ═══════════
  async function triggerManualBell() {

    if (await API.isManualBellLocked()) {
      const btn = $('#btnManualBell');

      if (btn) {
        btn.classList.add('btn-denied');

        setTimeout(() => {
          btn.classList.remove('btn-denied');
        }, 800);
      }

      return;
    }

    try {
      const result =
        await API.triggerManualBell();

      if (result.success) {

        showBellActive(false);

        startBellCountdown(
          result.duration || 3
        );

        updateManualBellUI();
        updateSystemStatus();

      } else if (
        result.error ===
        'RFID_AUTH_REQUIRED'
      ) {
        updateManualBellUI();
      }

    } catch (e) {
      console.error(
        'Manual bell failed:',
        e
      );
    }
  }

  // ═══════════ EMERGENCY BELL ═══════════
  async function triggerEmergencyBell() {

    try {
      const result =
        await API.triggerEmergencyBell();

      if (result.success) {

        showBellActive(true);

        startBellCountdown(
          result.duration || 3
        );

        updateSystemStatus();
      }

    } catch (e) {
      console.error(
        'Emergency bell failed:',
        e
      );
    }
  }

  // ═══════════ SHOW BELL ACTIVE ═══════════
  function showBellActive(isEmergency) {

    const banner =
      $('#bellActiveBanner');

    if (!banner) return;

    banner.classList.add('visible');

    if (isEmergency) {

      banner.classList.add(
        'emergency-active'
      );

      const text =
        banner.querySelector(
          'span:last-child'
        );

      if (text) {
        text.textContent =
          'EMERGENCY BELL ACTIVE';
      }

      const emergencyStatus =
        $('#emergencyStatus');

      if (emergencyStatus) {
        emergencyStatus.textContent =
          'ACTIVE';

        emergencyStatus.style.color =
          'var(--red)';
      }

    } else {

      banner.classList.remove(
        'emergency-active'
      );

      const text =
        banner.querySelector(
          'span:last-child'
        );

      if (text) {
        text.textContent =
          'BELL RINGING';
      }

      const emergencyStatus =
        $('#emergencyStatus');

      if (emergencyStatus) {
        emergencyStatus.textContent =
          'Inactive';

        emergencyStatus.style.color =
          '';
      }
    }
  }

  // ═══════════ HIDE BELL ACTIVE ═══════════
  function hideBellActive(
    refreshStatus = true
  ) {

    const banner =
      $('#bellActiveBanner');

    if (banner) {
      banner.classList.remove(
        'visible',
        'emergency-active'
      );

      const text =
        banner.querySelector(
          'span:last-child'
        );

      if (text) {
        text.textContent =
          'BELL RINGING';
      }
    }

    const emergencyStatus =
      $('#emergencyStatus');

    if (emergencyStatus) {
      emergencyStatus.textContent =
        'Inactive';

      emergencyStatus.style.color =
        '';
    }

    const countdown =
      $('#bellCountdown');

    if (countdown) {
      countdown.textContent = '—';
    }

    updateManualBellUI();

    if (refreshStatus) {
      updateSystemStatus();
    }
  }

  // ═══════════ BELL COUNTDOWN ═══════════
  function startBellCountdown(duration) {

    duration =
      Number(duration) || 3;

    const durationEl =
      $('#bellDuration');

    const countdownEl =
      $('#bellCountdown');

    if (durationEl) {
      durationEl.textContent =
        `${duration}s`;
    }

    if (countdownEl) {
      countdownEl.textContent =
        `${duration}s`;
    }

    if (bellTimer) {
      clearInterval(bellTimer);
      bellTimer = null;
    }

    let localRemaining = duration;

    bellTimer = setInterval(async () => {

      // Read actual state from ESP32
      try {
        const status =
          await API.getStatus();

        if (status.bellActive) {

          if (
            typeof status.bellCountdown ===
            'number' &&
            status.bellCountdown > 0
          ) {
            if (countdownEl) {
              countdownEl.textContent =
                `${status.bellCountdown}s`;
            }
          }

          return;
        }

        // ESP32 says bell is OFF
        clearInterval(bellTimer);
        bellTimer = null;

        hideBellActive(false);

        if (durationEl) {
          durationEl.textContent = '3s';
        }

      } catch (e) {

        // Fallback local countdown
        localRemaining--;

        if (localRemaining > 0) {

          if (countdownEl) {
            countdownEl.textContent =
              `${localRemaining}s`;
          }

        } else {

          clearInterval(bellTimer);
          bellTimer = null;

          hideBellActive(false);

          if (durationEl) {
            durationEl.textContent = '3s';
          }
        }
      }

    }, 500);
  }

  // ═══════════ TIMETABLE DISPLAY ═══════════
  async function loadTimetable() {

    try {

      const entries =
        await API.getTimetable();

      const tbody =
        $('#timetableRows');

      if (!tbody) return;

      tbody.innerHTML = '';

      const now = new Date();

      const currentMinutes =
        now.getHours() * 60 +
        now.getMinutes();

      entries.forEach(entry => {

        if (!entry.enabled) return;

        const [sh, sm] =
          entry.start.split(':').map(Number);

        const [eh, em] =
          entry.end.split(':').map(Number);

        const startMin =
          sh * 60 + sm;

        const endMin =
          eh * 60 + em;

        let statusClass = '';
        let statusBadge = '';

        if (
          currentMinutes >= startMin &&
          currentMinutes < endMin
        ) {

          statusClass =
            'current-period';

          statusBadge =
            '<span class="period-badge period-badge-active">● Current</span>';

        } else if (
          currentMinutes >= endMin
        ) {

          statusClass =
            'period-completed';

          statusBadge =
            '<span class="period-badge period-badge-done">✓ Done</span>';

        } else {

          statusBadge =
            '<span class="period-badge period-badge-upcoming">○ Upcoming</span>';
        }

        const tr =
          document.createElement('tr');

        tr.className =
          statusClass;

        tr.innerHTML = `
          <td>${entry.period}</td>
          <td>${formatTime12(entry.start)}</td>
          <td>${formatTime12(entry.end)}</td>
          <td>${entry.name}</td>
          <td>${entry.duration}s</td>
          <td>${statusBadge}</td>
        `;

        tbody.appendChild(tr);
      });

    } catch (e) {

      console.error(
        'Failed to load timetable:',
        e
      );
    }
  }

  // ═══════════ NEXT BELL COUNTDOWN ═══════════
  function startNextBellCountdown() {

    async function update() {

      try {

        const entries =
          await API.getTimetable();

        const now = new Date();

        const currentMinutes =
          now.getHours() * 60 +
          now.getMinutes();

        const currentSeconds =
          now.getSeconds();

        const totalSecondsNow =
          currentMinutes * 60 +
          currentSeconds;

        let nextBellSeconds = null;

        for (const entry of entries) {

          if (!entry.enabled) continue;

          const [sh, sm] =
            entry.start.split(':').map(Number);

          const entryTotalSeconds =
            (sh * 60 + sm) * 60;

          if (
            entryTotalSeconds >
            totalSecondsNow
          ) {

            nextBellSeconds =
              entryTotalSeconds -
              totalSecondsNow;

            break;
          }
        }

        const chip =
          $('#nextBellChip');

        const timeEl =
          $('#nextBellTime');

        if (!chip || !timeEl) return;

        if (nextBellSeconds !== null) {

          const mins =
            Math.floor(
              nextBellSeconds / 60
            );

          const secs =
            nextBellSeconds % 60;

          const hrs =
            Math.floor(mins / 60);

          const remainMins =
            mins % 60;

          if (hrs > 0) {

            timeEl.textContent =
              `${hrs}h ${String(remainMins).padStart(2, '0')}m`;

          } else {

            timeEl.textContent =
              `${remainMins}:${String(secs).padStart(2, '0')}`;
          }

          chip.style.display = 'flex';

        } else {

          chip.style.display = 'none';
        }

      } catch (e) {

        console.error(
          'Next bell update failed:',
          e
        );
      }
    }

    update();

    setInterval(
      update,
      1000
    );

    setInterval(
      loadTimetable,
      30000
    );
  }

  // ═══════════ TIMETABLE MANAGER ═══════════
  async function loadManagerTable() {

    try {

      const entries =
        await API.getTimetable();

      const tbody =
        $('#managerRows');

      if (!tbody) return;

      tbody.innerHTML = '';

      entries.forEach(entry => {

        const tr =
          document.createElement('tr');

        tr.innerHTML = `
          <td>${entry.period}</td>
          <td>${formatTime12(entry.start)}</td>
          <td>${formatTime12(entry.end)}</td>
          <td>${entry.name}</td>
          <td>${entry.duration}</td>

          <td>
            <label class="toggle-switch toggle-sm">
              <input
                type="checkbox"
                ${entry.enabled ? 'checked' : ''}
                onchange="App.toggleEntry(${entry.id})"
              />
              <span class="toggle-slider"></span>
            </label>
          </td>

          <td>
            <button
              class="action-btn"
              onclick="App.editEntry(${entry.id})"
              title="Edit"
            >✎</button>

            <button
              class="action-btn action-btn-delete"
              onclick="App.deleteEntry(${entry.id})"
              title="Delete"
            >✕</button>
          </td>
        `;

        tbody.appendChild(tr);
      });

    } catch (e) {

      console.error(
        'Failed to load manager table:',
        e
      );
    }
  }

  // ═══════════ AUTHENTICATION ═══════════
  async function simulateAuth() {

    try {

      const result =
        await API.authenticateRFID();

      if (result.success) {

        isAuthenticated = true;

        $('#managerOverlay').style.display =
          'none';

        $('#managerContent').style.display =
          'block';

        $('#managerLockBadge').innerHTML = `
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <rect
              x="3"
              y="11"
              width="18"
              height="11"
              rx="2"
            />
            <path
              d="M7 11V7a5 5 0 0 1 10 0v4"
            />
          </svg>
          UNLOCKED
        `;

        $('#managerLockBadge').className =
          'card-badge badge-online';

        updateManualBellUI();
        updateSystemStatus();
      }

    } catch (e) {

      console.error(
        'Auth failed:',
        e
      );
    }
  }

  // ═══════════ LOCK MANAGER ═══════════
  async function lockManager() {

    try {

      await API.lockAuth();

      isAuthenticated = false;

      $('#managerOverlay').style.display =
        '';

      $('#managerContent').style.display =
        'none';

      $('#managerLockBadge').innerHTML = `
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect
            x="3"
            y="11"
            width="18"
            height="11"
            rx="2"
          />
          <path
            d="M7 11V7a5 5 0 0 1 10 0v4"
          />
        </svg>
        ADMIN ONLY
      `;

      $('#managerLockBadge').className =
        'card-badge badge-locked';

      updateManualBellUI();
      updateSystemStatus();

    } catch (e) {

      console.error(
        'Lock failed:',
        e
      );
    }
  }

  // ═══════════ MODAL ═══════════
  function openAddModal() {

    editingEntryId = null;

    $('#modalTitle').textContent =
      'Add Timetable Entry';

    $('#btnSaveEntry').textContent =
      'Add Entry';

    $('#formPeriod').value = '';
    $('#formStart').value = '';
    $('#formEnd').value = '';
    $('#formName').value = '';
    $('#formDuration').value = 3;
    $('#formEnabled').checked = true;
    $('#formEditId').value = '';

    $('#modalOverlay').classList.add(
      'open'
    );
  }

  async function editEntry(id) {

    const entries =
      await API.getTimetable();

    const entry =
      entries.find(e => e.id === id);

    if (!entry) return;

    editingEntryId = id;

    $('#modalTitle').textContent =
      'Edit Timetable Entry';

    $('#btnSaveEntry').textContent =
      'Save Changes';

    $('#formPeriod').value =
      entry.period;

    $('#formStart').value =
      entry.start;

    $('#formEnd').value =
      entry.end;

    $('#formName').value =
      entry.name;

    $('#formDuration').value =
      entry.duration;

    $('#formEnabled').checked =
      entry.enabled;

    $('#formEditId').value =
      id;

    $('#modalOverlay').classList.add(
      'open'
    );
  }

  function closeModal() {
    $('#modalOverlay').classList.remove(
      'open'
    );

    editingEntryId = null;
  }

  // ═══════════ SAVE ENTRY ═══════════
  async function saveEntry(event) {

    event.preventDefault();

    const data = {
      period:
        parseInt(
          $('#formPeriod').value
        ),

      start:
        $('#formStart').value,

      end:
        $('#formEnd').value,

      name:
        $('#formName').value,

      duration:
        parseInt(
          $('#formDuration').value
        ),

      enabled:
        $('#formEnabled').checked,
    };

    try {
      let res;
      if (editingEntryId) {
        res = await API.updateEntry(
          editingEntryId,
          data
        );
      } else {
        res = await API.addEntry(data);
      }

      if (res && res.success === false) {
        alert(res.message || 'Save failed. Valid admin RFID authentication required.');
        return;
      }

      closeModal();
      loadManagerTable();
      loadTimetable();

    } catch (e) {
      console.error(
        'Save failed:',
        e
      );
    }
  }

  // ═══════════ DELETE ENTRY ═══════════
  async function deleteEntry(id) {
    if (
      !confirm(
        'Delete this timetable entry?'
      )
    ) {
      return;
    }

    try {
      const res = await API.deleteEntry(id);
      if (res && res.success === false) {
        alert(res.message || 'Delete failed. Valid admin RFID authentication required.');
        return;
      }

      loadManagerTable();
      loadTimetable();

    } catch (e) {
      console.error(
        'Delete failed:',
        e
      );
    }
  }

  // ═══════════ TOGGLE ENTRY ═══════════
  async function toggleEntry(id) {
    try {
      const res = await API.toggleEntry(id);
      if (res && res.success === false) {
        alert(res.message || 'Toggle failed. Valid admin RFID authentication required.');
        loadManagerTable();
        return;
      }

      loadTimetable();

    } catch (e) {
      console.error(
        'Toggle failed:',
        e
      );
    }
  }

  // ═══════════ SPECIAL MODES ═══════════
  async function toggleMode(mode) {

    const checkbox =
      $(
        `#toggle${mode.charAt(0).toUpperCase() +
        mode.slice(1)
        }`
      );

    if (!checkbox) return;

    const value =
      checkbox.checked;

    try {
      const result =
        await API.setMode(
          mode,
          value
        );

      if (result && result.success && result.modes) {
        Object.keys(
          result.modes
        ).forEach(key => {
          const toggleId =
            `#toggle${key.charAt(0).toUpperCase() +
            key.slice(1)
            }`;
          const toggleEl =
            $(toggleId);
          const modeItem =
            `#mode${key.charAt(0).toUpperCase() +
            key.slice(1)
            }`;
          const modeItemEl =
            $(modeItem);

          if (toggleEl) {
            toggleEl.checked =
              result.modes[key];
          }

          if (modeItemEl) {
            modeItemEl.classList.toggle(
              'mode-active',
              result.modes[key]
            );
          }
        });
      } else {
        checkbox.checked = !value;
        alert('Special Modes: Hardware extension is not yet connected in ESP32 firmware (Timetable mode active).');
      }

    } catch (e) {
      console.error(
        'Mode toggle failed:',
        e
      );
      checkbox.checked =
        !value;
    }
  }

  // ═══════════ HELPERS ═══════════
  function formatTime12(time24) {

    const [h, m] =
      time24.split(':').map(Number);

    const period =
      h >= 12 ? 'PM' : 'AM';

    const h12 =
      h % 12 || 12;

    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  }

  // ═══════════ PUBLIC API ═══════════
  return {

    init,

    triggerManualBell,

    triggerEmergencyBell,

    simulateAuth,

    lockManager,

    openAddModal,

    editEntry,

    closeModal,

    saveEntry,

    deleteEntry,

    toggleEntry,

    toggleMode,

  };

})();

// ═══════════ BOOT ═══════════
document.addEventListener(
  'DOMContentLoaded',
  App.init
);