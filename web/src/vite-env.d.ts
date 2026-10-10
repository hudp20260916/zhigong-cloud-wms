/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基址：前后端分离部署时指向后端完整地址，同域部署留空 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
