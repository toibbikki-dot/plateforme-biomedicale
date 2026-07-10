const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "biomedical_secret_key_2026";

const token = jwt.sign(
  {
    id: 1,
    email: "toibbikki@gmail.com",
    role: "ADMIN",
    organisation_id: 1,
    nom: "BIKIE",
    prenom: "Toib"
  },
  JWT_SECRET,
  { expiresIn: "10y" }
);

console.log(token);
