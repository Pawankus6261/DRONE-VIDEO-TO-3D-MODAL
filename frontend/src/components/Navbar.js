import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';

const Navbar = () => {
  const { isAuthenticated, logout } = useAuth0();
  const location = useLocation();

  // Helper function to determine if the link is active
  const isActive = (path) => location.pathname === path;

  return (
    <nav className="flex items-center justify-between px-10 py-4 border-b">
      {/* Left-aligned links */}
      <div className="flex space-x-4">
        <Link
          to="/"
          className={`font-semibold ${
            isActive('/') ? 'text-teal-500' : 'hover:underline'
          }`}
        >
          Home
        </Link>
        <Link
          to="/projects"
          className={`font-semibold ${
            isActive('/projects') ? 'text-teal-500' : 'hover:underline'
          }`}
        >
          My Projects
        </Link>
      </div>

      {/* Right-aligned buttons */}
      <div className="flex items-center space-x-4">
        <Link
          to="/profile"
          className={`font-semibold ${
            isActive('/profile') ? 'text-teal-500' : 'hover:underline'
          }`}
        >
          Profile
        </Link>
        {isAuthenticated ? (
          <button
            onClick={() => logout({ returnTo: window.location.origin })}
            className="bg-teal-500 text-white px-4 py-2 rounded-md font-semibold hover:bg-teal-600"
          >
            Log Out
          </button>
        ) : (
          <Link
            to="/login"
            className="bg-teal-500 text-white px-4 py-2 rounded-md font-semibold hover:bg-teal-600"
          >
            Log In
          </Link>
        )}
      </div>
    </nav>
  );
};

export default Navbar;