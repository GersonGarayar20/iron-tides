import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // ngrok (and similar tunnels) hand out a random hostname per run, which
    // Vite's Host-header allowlist rejects by default (DNS-rebinding
    // protection). Dev-only convenience for sharing the game over a tunnel.
    allowedHosts: true,
    proxy: {
      "/auth": "http://localhost:2567",
      "/tavern": "http://localhost:2567",
      // colyseus.js addresses both its matchmake HTTP calls and the room
      // WebSocket under the same host:port:pathname — giving the client a
      // fixed "/colyseus" pathname prefix (see SERVER_URL in OceanScene.ts)
      // means a single proxy entry with ws:true covers both, and the
      // rewrite strips the prefix so the server keeps seeing the exact
      // same root-mounted routes it already does today.
      "/colyseus": {
        target: "http://localhost:2567",
        ws: true,
        rewrite: (path) => path.replace(/^\/colyseus/, ""),
      },
    },
  },
});
