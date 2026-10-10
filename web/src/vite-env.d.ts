/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'mock' serves the built-in sample result instead of calling /api. */
  readonly VITE_API_MODE?: string;
}
