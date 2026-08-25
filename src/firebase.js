import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBaxLVUn2WAPKRFRSXJml6vXXZA334wVyk",
  authDomain: "nirnayam-460a8.firebaseapp.com",
  projectId: "nirnayam-460a8",
  storageBucket: "nirnayam-460a8.firebasestorage.app",
  messagingSenderId: "903267634430",
  appId: "1:903267634430:web:ae0f92b0e26c4d813329af"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const provider = new GoogleAuthProvider();
export const db = getFirestore(app);
