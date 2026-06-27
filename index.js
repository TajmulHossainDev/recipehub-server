const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("recipehub");
    const userCollection = db.collection("users");
    const recipeCollection = db.collection("recipes");
    const favoriteCollection = db.collection("favorites");
    const reportCollection = db.collection("reports");
    const paymentCollection = db.collection("payments");

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