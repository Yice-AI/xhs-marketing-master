import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import apiClient, { getAuthRequiredEventName } from '../services/apiClient';
import { AuthUser, clearStoredAuth, getStoredAccessToken, getStoredAuthUser, setStoredAuth } from '../services/authStorage';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (params: { username: string; password: string }) => Promise<void>;
  register: (params: { username: string; password: string; email?: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredAuthUser());
  const [isLoading, setIsLoading] = useState<boolean>(() => Boolean(getStoredAccessToken()));

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const token = getStoredAccessToken();
      if (!token) {
        setIsLoading(false);
        return;
      }
      try {
        const currentUser = await apiClient.getCurrentUser();
        if (!cancelled) {
          setUser(currentUser);
        }
      } catch (error) {
        clearStoredAuth();
        if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleAuthRequired = () => {
      clearStoredAuth();
      setUser(null);
      setIsLoading(false);
    };

    const eventName = getAuthRequiredEventName();
    window.addEventListener(eventName, handleAuthRequired);

    return () => {
      window.removeEventListener(eventName, handleAuthRequired);
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isLoading,
    login: async ({ username, password }) => {
      const data = await apiClient.login({ username, password });
      setStoredAuth(data.access_token, data.user);
      setUser(data.user);
    },
    register: async ({ username, password, email }) => {
      const data = await apiClient.register({ username, password, email });
      setStoredAuth(data.access_token, data.user);
      setUser(data.user);
    },
    logout: () => {
      clearStoredAuth();
      setUser(null);
    },
  }), [isLoading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
