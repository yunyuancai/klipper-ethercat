# Fluidd source patch

The Fluidd page/card is built from a small patch against fluidd v1.34.3:

1. `src/views/EtherCATView.vue` (in this folder) — the EtherCAT view
2. `src/router/index.ts` — add the route:

   ```ts
   import EtherCATView from '@/views/EtherCATView.vue'
   // ... after the settings route:
   {
     path: '/ethercat',
     name: 'ethercat',
     component: EtherCATView,
     ...defaultRouteConfig,
     meta: {}
   },
   ```

3. `src/components/layout/AppNavDrawer.vue` — add the nav entry below Settings:

   ```html
   <app-nav-item icon="$power" to="ethercat">EtherCAT</app-nav-item>
   ```

4. `src/globals.ts` — register the icon (mdiPower is already imported):

   ```ts
   power: mdiPower,
   ```

Then `npm ci && npm run build` and deploy `dist/` as your fluidd web root
(the stock fluidd web root is replaced — keep a backup).
