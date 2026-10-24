import Phaser from "phaser";
import { login, playAsGuest, register } from "./auth";
import { OceanScene } from "./scenes/OceanScene";
import { getSession, loadStoredSession, setSession, type SessionInfo } from "./session";

function startGame() {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    backgroundColor: "#05151f",
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    scene: [OceanScene],
  });
}

// Plain DOM gate in front of the canvas, matching the plan's "keep it
// proportionate" note: registration/login/guest is a one-off form, not
// worth a Phaser scene.
function showAuthGate() {
  const root = document.createElement("div");
  root.id = "auth-gate";
  root.innerHTML = `
    <div class="auth-card">
      <h1>Iron Tides</h1>
      <button id="auth-guest" type="button">Play as Guest</button>
      <div class="auth-divider">or sign in</div>
      <form id="auth-login-form">
        <input id="auth-email" type="email" placeholder="email" autocomplete="email" required />
        <input
          id="auth-password"
          type="password"
          placeholder="password (min 8 chars)"
          autocomplete="current-password"
          minlength="8"
          required
        />
        <div class="auth-actions">
          <button id="auth-login" type="submit">Login</button>
          <button id="auth-register" type="button">Register</button>
        </div>
      </form>
      <div id="auth-error" class="auth-error"></div>
    </div>
  `;
  document.body.appendChild(root);

  const errorBox = root.querySelector<HTMLDivElement>("#auth-error")!;
  const emailInput = root.querySelector<HTMLInputElement>("#auth-email")!;
  const passwordInput = root.querySelector<HTMLInputElement>("#auth-password")!;

  function onSuccess(session: SessionInfo) {
    setSession(session);
    root.remove();
    startGame();
  }

  function showError(err: unknown) {
    errorBox.textContent = err instanceof Error ? err.message : "something went wrong";
  }

  root.querySelector("#auth-guest")!.addEventListener("click", async () => {
    try {
      const res = await playAsGuest();
      onSuccess({
        token: res.token,
        playerId: res.player.id,
        displayName: res.player.displayName,
        isGuest: true,
      });
    } catch (err) {
      showError(err);
    }
  });

  root.querySelector("#auth-login-form")!.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const res = await login(emailInput.value, passwordInput.value);
      onSuccess({
        token: res.token,
        playerId: res.player.id,
        displayName: res.player.displayName,
        isGuest: res.player.isGuest,
      });
    } catch (err) {
      showError(err);
    }
  });

  root.querySelector("#auth-register")!.addEventListener("click", async () => {
    try {
      const res = await register(emailInput.value, passwordInput.value);
      onSuccess({
        token: res.token,
        playerId: res.player.id,
        displayName: res.player.displayName,
        isGuest: res.player.isGuest,
      });
    } catch (err) {
      showError(err);
    }
  });
}

const stored = loadStoredSession();
if (stored && getSession()) {
  startGame();
} else {
  showAuthGate();
}
