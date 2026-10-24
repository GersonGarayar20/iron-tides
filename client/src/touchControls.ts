import type { CannonSide, ShipInput } from "@iron-tides/shared";

// Phase 7 (third slice): mobile/touch controls. A virtual joystick
// (bottom-left) plus two fire buttons (bottom-right) — plain DOM overlays,
// same approach OceanScene already uses for the dock/chat/social panels,
// kept in their own module since the drag bookkeeping doesn't belong on
// the scene. Only ever created when isTouchDevice() is true.
//
// The joystick does NOT invent a new input protocol: it maps drag position
// to the exact same discrete {throttle, turn} ShipInput the W/S/A/D keys
// already produce (see OceanScene.readInput), just via a dead zone + sign
// threshold instead of key state. OceanScene still owns reading this,
// merging it with keyboard state, and sending it — this module only
// produces the signal.
const DEAD_ZONE = 0.35;
const THUMB_SIZE = 52;
const EDGE_MARGIN = 16;

export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export interface TouchControls {
  getInput(): ShipInput;
  destroy(): void;
}

function toAxis(delta: number, radius: number): -1 | 0 | 1 {
  const normalized = Math.max(-1, Math.min(1, delta / radius));
  if (Math.abs(normalized) < DEAD_ZONE) return 0;
  return normalized > 0 ? 1 : -1;
}

export function createTouchControls(onFire: (side: CannonSide) => void): TouchControls {
  let throttle: ShipInput["throttle"] = 0;
  let turn: ShipInput["turn"] = 0;
  let activePointerId: number | null = null;

  const root = document.createElement("div");
  root.id = "touch-controls";

  const base = document.createElement("div");
  base.id = "touch-joystick-base";
  const thumb = document.createElement("div");
  thumb.id = "touch-joystick-thumb";
  base.appendChild(thumb);

  const fireWrap = document.createElement("div");
  fireWrap.id = "touch-fire-buttons";
  const portBtn = document.createElement("button");
  portBtn.id = "touch-fire-port";
  portBtn.type = "button";
  portBtn.textContent = "PORT";
  const starboardBtn = document.createElement("button");
  starboardBtn.id = "touch-fire-starboard";
  starboardBtn.type = "button";
  starboardBtn.textContent = "STBD";
  fireWrap.appendChild(portBtn);
  fireWrap.appendChild(starboardBtn);

  root.appendChild(base);
  root.appendChild(fireWrap);
  document.body.appendChild(root);

  function resetThumb() {
    // CSS (left/top/margin) already centers the thumb inside the base at
    // rest; dragging only ever adds an extra translate() on top of that,
    // so releasing just clears the translate back to none.
    thumb.style.transform = "";
    throttle = 0;
    turn = 0;
  }
  resetThumb();

  function handleMove(clientX: number, clientY: number) {
    const rect = base.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const radius = rect.width / 2;
    const distance = Math.min(Math.hypot(dx, dy), radius);
    const angle = Math.atan2(dy, dx);
    const clampedX = Math.cos(angle) * distance;
    const clampedY = Math.sin(angle) * distance;
    // Read the thumb's actual rendered size (CSS shrinks it in the
    // landscape/short-viewport media query) rather than assuming a fixed
    // constant, so the drag offset always lines up with what's on screen.
    const thumbHalf = thumb.offsetWidth / 2 || THUMB_SIZE / 2;
    thumb.style.transform = `translate(${clampedX - thumbHalf}px, ${clampedY - thumbHalf}px)`;

    // Up (negative screen Y) is throttle forward, right is turn starboard —
    // the same sign convention W/S/A/D already map to in readInput().
    throttle = -toAxis(dy, radius) as ShipInput["throttle"];
    turn = toAxis(dx, radius) as ShipInput["turn"];
  }

  base.addEventListener("pointerdown", (event) => {
    if (activePointerId !== null) return;
    activePointerId = event.pointerId;
    base.setPointerCapture(event.pointerId);
    handleMove(event.clientX, event.clientY);
  });
  base.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointerId) return;
    handleMove(event.clientX, event.clientY);
  });
  function endDrag(event: PointerEvent) {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    // Releasing snaps back to center/neutral, same as letting go of W/S/A/D.
    resetThumb();
  }
  base.addEventListener("pointerup", endDrag);
  base.addEventListener("pointercancel", endDrag);

  // pointerdown (not click) so a tap fires immediately and once, matching
  // the JustDown semantics Q/E already use — fire() itself still gates on
  // reload/ammo, this just triggers the same call.
  portBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    onFire("port");
  });
  starboardBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    onFire("starboard");
  });

  // The chat panel (bottom-left, always visible, see OceanScene.createChatUI)
  // is a fixed-width DOM block whose height can shift slightly with font
  // rendering — measuring its real top edge beats guessing a pixel offset
  // that could drift and overlap it across phone sizes/orientations.
  function reposition() {
    const chatPanel = document.getElementById("chat-panel");
    const chatTop = chatPanel ? chatPanel.getBoundingClientRect().top : window.innerHeight;
    const bottomOffset = Math.max(EDGE_MARGIN, window.innerHeight - chatTop + EDGE_MARGIN);
    base.style.bottom = `${bottomOffset}px`;
  }
  reposition();
  window.addEventListener("resize", reposition);
  window.addEventListener("orientationchange", reposition);

  return {
    getInput: () => ({ throttle, turn }),
    destroy: () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("orientationchange", reposition);
      root.remove();
    },
  };
}
