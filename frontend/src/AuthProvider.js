import React, { useState } from 'react';
import { Auth0Provider, Auth0Context } from '@auth0/auth0-react';

// Default mock user for local development without Auth0
const DEFAULT_LOCAL_USER = {
  name: 'Local User',
  nickname: 'dex_user',
  email: 'user@dex.local',
  sub: 'auth0|local_user',
  picture: 'https://api.dicebear.com/7.x/bottts/svg?seed=dex'
};

/**
 * AuthProviderWrapper:
 * If Auth0 credentials are provided in .env, it uses the official Auth0Provider.
 * If not, it provides a mock Auth0 context so the app works seamlessly offline / locally
 * without redirecting to Auth0 or crashing.
 */
export const AuthProviderWrapper = ({ children }) => {
  const domain = process.env.REACT_APP_AUTH0_DOMAIN || process.env.REACT_APP_AUTH_0_DOMAIN;
  const clientId = process.env.REACT_APP_AUTH0_CLIENT_ID || process.env.REACT_APP_AUTH_0_CLIENT_ID;

  const isAuth0Configured = Boolean(
    domain && 
    clientId && 
    !domain.includes('...') && 
    !clientId.includes('...') &&
    domain !== 'your-auth0-domain'
  );

  const [localUser] = useState(DEFAULT_LOCAL_USER);
  const [isAuthenticated, setIsAuthenticated] = useState(true);

  if (isAuth0Configured) {
    return (
      <Auth0Provider
        domain={domain}
        clientId={clientId}
        authorizationParams={{
          redirect_uri: window.location.origin,
        }}
        cacheLocation="localstorage"
      >
        {children}
      </Auth0Provider>
    );
  }

  // Fallback Mock Auth0 Context
  const mockAuthContextValue = {
    isAuthenticated,
    user: localUser,
    isLoading: false,
    loginWithRedirect: async () => {
      console.log("[Auth] Mock login triggered");
      setIsAuthenticated(true);
    },
    loginWithPopup: async () => {
      console.log("[Auth] Mock popup login triggered");
      setIsAuthenticated(true);
    },
    logout: async () => {
      console.log("[Auth] Mock logout triggered");
      setIsAuthenticated(false);
    },
    getAccessTokenSilently: async () => 'mock_access_token',
    getAccessTokenWithPopup: async () => 'mock_access_token',
    getIdTokenClaims: async () => ({ __raw: 'mock_id_token' }),
    handleRedirectCallback: async () => ({ appState: {} })
  };

  return (
    <Auth0Context.Provider value={mockAuthContextValue}>
      {children}
    </Auth0Context.Provider>
  );
};

export default AuthProviderWrapper;
