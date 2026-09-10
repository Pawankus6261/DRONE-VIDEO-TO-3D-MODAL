import React from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import Navbar from '../components/Navbar';

const Profile = () => {
  const { user, isAuthenticated, loginWithRedirect, isLoading } = useAuth0();

  if (isLoading) {
    return <p className="text-center mt-10">Loading...</p>;
  }

  const currentUser = user || {
    name: 'Guest User',
    email: 'guest@dex.local',
    picture: 'https://api.dicebear.com/7.x/bottts/svg?seed=dex'
  };

  return (
    <div>
      <Navbar />
      <div className="flex flex-col items-center p-10">
        <h1 className="text-3xl font-bold mb-6">Profile</h1>
        <div className="w-full max-w-md bg-white shadow-lg rounded-lg p-6 flex flex-col items-center">
          {currentUser.picture && (
            <img
              src={currentUser.picture}
              alt="Profile"
              className="rounded-full w-32 h-32 mb-4 border-2 border-teal-500"
            />
          )}
          <h2 className="text-xl font-semibold">{currentUser.name}</h2>
          <p className="text-gray-500 mb-4">{currentUser.email}</p>

          {!isAuthenticated && (
            <div className="mt-4 p-4 bg-teal-50 rounded-lg text-center w-full border border-teal-200">
              <span className="inline-block px-2 py-1 text-xs font-semibold bg-teal-100 text-teal-800 rounded-full mb-2">
                Guest / Local Mode
              </span>
              <p className="text-xs text-gray-600 mb-3">
                You are currently using Dex locally without an Auth0 session.
              </p>
              <button
                onClick={() => loginWithRedirect()}
                className="bg-teal-500 text-white px-4 py-2 rounded text-sm font-medium hover:bg-teal-600"
              >
                Log In with Auth0
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Profile;
