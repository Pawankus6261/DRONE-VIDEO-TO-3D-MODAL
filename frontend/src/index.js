import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import AuthProviderWrapper from './AuthProvider';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <AuthProviderWrapper>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </AuthProviderWrapper>
);

reportWebVitals();
