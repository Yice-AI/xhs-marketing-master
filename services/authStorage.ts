const ACCESS_TOKEN_KEY = 'xhs_access_token';
const AUTH_USER_KEY = 'xhs_auth_user';

export interface AuthUser {
  user_id: string;
  username: string;
  email?: string | null;
  is_active: boolean;
}

const readStorage = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(key);
};

export const getStoredAccessToken = (): string | null => readStorage(ACCESS_TOKEN_KEY);

export const setStoredAuth = (token: string, user: AuthUser) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCESS_TOKEN_KEY, token);
  window.localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
};

export const clearStoredAuth = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(AUTH_USER_KEY);
};

export const getStoredAuthUser = (): AuthUser | null => {
  const raw = readStorage(AUTH_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
};
