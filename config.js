// Firebase-Konfiguration hier einfügen, um Sync zwischen euren Handys zu aktivieren.
// Solange null: App läuft nur lokal auf diesem Gerät.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCHfZYxqHgmmssIg7gjyxZbL5tSijIF_IU",
  authDomain: "meine-r.firebaseapp.com",
  projectId: "meine-r",
  storageBucket: "meine-r.firebasestorage.app",
  messagingSenderId: "969268852046",
  appId: "1:969268852046:web:01a4ab4a267681f72f1a1f"
};
// Adresse des Cloudflare Workers für den KI-Import (leer = KI-Funktion aus).
window.RECIPE_WORKER = "https://rezepte-ki.jnhbr97.workers.dev";
