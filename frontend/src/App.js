import React from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import Login from './pages/Login';
import Home from './pages/Home';
import Projects from './pages/Projects';
import Profile from './pages/Profile';
import Rendering from './pages/Rendering';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/rendering" element={<Rendering />} />
      </Routes>
    </Router>
  );
}

export default App;
