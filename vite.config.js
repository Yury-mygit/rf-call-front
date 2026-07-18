export default {
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5189,
    strictPort: true,
    allowedHosts: ['call.dev.raftforge.art'],
    // HMR через WSS за Caddy (feedback_vite_hmr_subprotocol):
    hmr: {
      protocol: 'wss',
      host: 'call.dev.raftforge.art',
      clientPort: 443,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
};
