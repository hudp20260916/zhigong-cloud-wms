import { create } from 'zustand';
import { getToken, setToken } from '../api/client';
import { authApi, type UserInfo } from '../api';

export interface AuthState {
  token: string | null;
  user: UserInfo | null;
  permissions: string[];
  ready: boolean;
  init: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  has: (permission: string) => boolean;
  canViewPrice: () => boolean;
  canExport: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: getToken(),
  user: null,
  permissions: [],
  ready: false,

  async init() {
    const token = getToken();
    if (!token) {
      set({ ready: true, token: null, user: null, permissions: [] });
      return;
    }
    try {
      const me = await authApi.me();
      set({
        token,
        ready: true,
        user: {
          id: me.id,
          username: me.username,
          displayName: me.displayName,
          role: me.role,
          permissions: me.permissions,
        },
        permissions: me.permissions,
      });
    } catch {
      setToken(null);
      set({ ready: true, token: null, user: null, permissions: [] });
    }
  },

  async login(username, password) {
    const data = await authApi.login(username, password);
    setToken(data.token);
    set({
      token: data.token,
      user: { ...data.user, permissions: data.permissions },
      permissions: data.permissions,
      ready: true,
    });
  },

  logout() {
    setToken(null);
    set({ token: null, user: null, permissions: [], ready: true });
  },

  has(permission: string) {
    return get().permissions.includes(permission);
  },

  canViewPrice() {
    return get().permissions.includes('price.view');
  },

  canExport() {
    return get().permissions.includes('export.data');
  },
}));
