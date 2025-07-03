const path = require('path');
const bcrypt = require('bcrypt');
const usersFilePath = path.join(__dirname, 'users.json');

function loadUsers() {
  if (!fs.existsSync(usersFilePath)) return [];
  return JSON.parse(fs.readFileSync(usersFilePath, 'utf-8'));
}

function saveUsers(users) {
  fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf-8');
}

async function registerUser(req, res) {
  const { email, password, confirmPassword, name, phone, address } = req.body;
  if (!email || !password || !confirmPassword || !name || !phone || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }

  const users = loadUsers();
  if (users.find(user => user.email === email)) {
    return res.status(409).json({ error: 'User already exists' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    users.push({ email, password: hashedPassword, name, phone, address });
    saveUsers(users);
    res.json({ success: true, message: 'Registration successful' });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
}

async function loginUser(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  const users = loadUsers();
  const user = users.find(u => u.email === email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({ success: true, message: 'Login successful', name: user.name });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
}

module.exports = { registerUser, loginUser };

