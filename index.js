const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

const verifyToken = async (req, res, next) => {
  let token = req.cookies?.auth_token;

  if (!token) {
    const authHeader = req?.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "unauthorized" });
    }
    token = authHeader.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ message: "unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(403).json({
      message: "Forbidden",
      error: error.message,
    });
  }
};

const verifyAdmin = async (req, res, next) => {
  const email = req.user?.email;
  const db = client.db("recipehub");
  const userCollection = db.collection("users");
  const user = await userCollection.findOne({ email });

  if (!user || user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Admins only" });
  }
  next();
};

async function run() {
  try {
    const db = client.db("recipehub");
    const userCollection = db.collection("users");
    const recipeCollection = db.collection("recipes");
    const favoriteCollection = db.collection("favorites");
    const reportCollection = db.collection("reports");
    const paymentCollection = db.collection("payments");

    app.post("/auth/set-cookie", (req, res) => {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ message: "Token required" });
      }
      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.json({ message: "Cookie set successfully" });
    });

    app.post("/auth/clear-cookie", (req, res) => {
      res.clearCookie("auth_token");
      res.json({ message: "Cookie cleared" });
    });

    app.post("/users", async (req, res) => {
      const userData = req.body;
      const existingUser = await userCollection.findOne({
        email: userData.email,
      });
      if (existingUser) {
        return res.json({ message: "User already exists", inserted: false });
      }
      const newUser = {
        name: userData.name,
        email: userData.email,
        image: userData.image || "",
        role: "user",
        isBlocked: false,
        isPremium: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await userCollection.insertOne(newUser);
      res.json(result);
    });

    app.get("/users/admin/:email", verifyToken, async (req, res) => {
      const { email } = req.params;
      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }
      const user = await userCollection.findOne({ email });
      const isAdmin = user?.role === "admin";
      res.json({ admin: isAdmin });
    });

    app.get("/users/:email", verifyToken, async (req, res) => {
      const { email } = req.params;
      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }
      const user = await userCollection.findOne({ email });
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json(user);
    });

    app.patch(
      "/users/block/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { isBlocked } = req.body;
        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isBlocked, updatedAt: new Date() } },
        );
        res.json(result);
      },
    );

    app.patch("/users/profile/:email", verifyToken, async (req, res) => {
      const { email } = req.params;
      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }
      const { name, image } = req.body;
      const updateDoc = { updatedAt: new Date() };
      if (name) updateDoc.name = name;
      if (image) updateDoc.image = image;
      const result = await userCollection.updateOne(
        { email },
        { $set: updateDoc },
      );
      res.json(result);
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(result);
    });

    console.log("Connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("RecipeHub server is running");
});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});