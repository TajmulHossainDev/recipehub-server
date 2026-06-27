const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const dotenv = require("dotenv");
dotenv.config();
const express = require("express");
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT || 5000;

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      return res.status(400).json({ message: `Webhook error: ${err.message}` });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const { type, userEmail, recipeId } = session.metadata;
      await paymentCollection.insertOne({
        userEmail,
        userId: session.metadata.userId || "",
        amount: session.amount_total / 100,
        recipeId: recipeId || null,
        transactionId: session.payment_intent,
        paymentStatus: "success",
        type,
        paidAt: new Date(),
      });
      if (type === "premium") {
        await userCollection.updateOne(
          { email: userEmail },
          { $set: { isPremium: true, updatedAt: new Date() } },
        );
      }
    }

    res.json({ received: true });
  },
);

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
  const userCollection = db.collection("user");
  const user = await userCollection.findOne({ email });

  if (!user || user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Admins only" });
  }
  next();
};

async function run() {
  try {
    const db = client.db("recipehub");
    const userCollection = db.collection("user");
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
     app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(result);
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
    app.get("/recipes", async (req, res) => {
      const { category, search, page = 1, limit = 6 } = req.query;

      const query = {};

      if (category && category !== "All") {
        query.category = { $in: [category] };
      }

      if (search) {
        query.recipeName = { $regex: search, $options: "i" };
      }

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;

      const total = await recipeCollection.countDocuments(query);
      const recipes = await recipeCollection
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray();

      res.json({
        recipes,
        total,
        totalPages: Math.ceil(total / limitNum),
        currentPage: pageNum,
      });
    });
    app.get("/recipes/categories", async (req, res) => {
      const categories = await recipeCollection
        .aggregate([
          {
            $group: {
              _id: "$category",
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              name: "$_id",
              count: 1,
            },
          },
          {
            $sort: { name: 1 },
          },
        ])
        .toArray();

      res.send(categories);
    });
    app.get("/recipes/featured", async (req, res) => {
      const result = await recipeCollection
        .find({ isFeatured: true })
        .limit(6)
        .toArray();
      res.json(result);
    });
    app.get("/recipes/popular", async (req, res) => {
      const result = await recipeCollection
        .find()
        .sort({ likesCount: -1 })
        .limit(4)
        .toArray();
      res.json(result);
    });

    app.get("/recipes/:id", async (req, res) => {
      const { id } = req.params;
      const result = await recipeCollection.findOne({ _id: new ObjectId(id) });
      if (!result) {
        return res.status(404).json({ message: "Recipe not found" });
      }
      res.json(result);
    });
    app.get("/my-recipes/:email", verifyToken, async (req, res) => {
      const { email } = req.params;

      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const result = await recipeCollection
        .find({ authorEmail: email })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(result);
    });

    app.post("/recipes", verifyToken, async (req, res) => {
      const recipeData = req.body;

      if (req.user.email !== recipeData.authorEmail) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const author = await userCollection.findOne({
        email: recipeData.authorEmail,
      });
      const userRecipeCount = await recipeCollection.countDocuments({
        authorEmail: recipeData.authorEmail,
      });

      const FREE_LIMIT = 2;
      if (!author?.isPremium && userRecipeCount >= FREE_LIMIT) {
        return res.status(403).json({
          message:
            "Free plan limit reached. Upgrade to premium to add more recipes.",
        });
      }

      const newRecipe = {
        ...recipeData,
        likesCount: 0,
        isFeatured: false,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await recipeCollection.insertOne(newRecipe);
      res.json(result);
    });

    app.patch("/recipes/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      const recipe = await recipeCollection.findOne({ _id: new ObjectId(id) });
      if (!recipe) {
        return res.status(404).json({ message: "Recipe not found" });
      }
      if (recipe.authorEmail !== req.user.email) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const result = await recipeCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { ...updateData, updatedAt: new Date() } },
      );
      res.json(result);
    });

    app.delete("/recipes/:id", verifyToken, async (req, res) => {
      const { id } = req.params;

      const recipe = await recipeCollection.findOne({ _id: new ObjectId(id) });
      if (!recipe) {
        return res.status(404).json({ message: "Recipe not found" });
      }
      if (recipe.authorEmail !== req.user.email) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const result = await recipeCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.json(result);
    });
    app.patch("/recipes/like/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { liked } = req.body;

      const result = await recipeCollection.updateOne(
        { _id: new ObjectId(id) },
        { $inc: { likesCount: liked ? 1 : -1 } },
      );
      res.json(result);
    });
    app.get("/admin/recipes", verifyToken, verifyAdmin, async (req, res) => {
      const result = await recipeCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.json(result);
    });
    app.patch(
      "/admin/recipes/feature/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { isFeatured } = req.body;

        const result = await recipeCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isFeatured, updatedAt: new Date() } },
        );
        res.json(result);
      },
    );
    app.delete(
      "/admin/recipes/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const result = await recipeCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.json(result);
      },
    );
    app.put(
      "/admin/recipes/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const {
          recipeName,
          category,
          cuisineType,
          difficultyLevel,
          preparationTime,
        } = req.body;

        const updateFields = {};
        if (recipeName) updateFields.recipeName = recipeName;
        if (category) updateFields.category = category;
        if (cuisineType) updateFields.cuisineType = cuisineType;
        if (difficultyLevel) updateFields.difficultyLevel = difficultyLevel;
        if (preparationTime) updateFields.preparationTime = preparationTime;
        updateFields.updatedAt = new Date();

        const result = await recipeCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateFields },
        );
        res.json(result);
      },
    );
    app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
      const totalUsers = await userCollection.countDocuments();
      const totalRecipes = await recipeCollection.countDocuments();
      const totalPremiumMembers = await userCollection.countDocuments({
        isPremium: true,
      });
      const totalReports = await reportCollection.countDocuments({
        status: "pending",
      });
      res.json({ totalUsers, totalRecipes, totalPremiumMembers, totalReports });
    });
    
    app.post("/favorites", verifyToken, async (req, res) => {
      const { userEmail, recipeId } = req.body;

      if (req.user.email !== userEmail) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const existing = await favoriteCollection.findOne({
        userEmail,
        recipeId,
      });
      if (existing) {
        return res.status(409).json({ message: "Already in favorites" });
      }

      const newFavorite = {
        userEmail,
        userId: req.user.id || req.user.sub,
        recipeId,
        addedAt: new Date(),
      };

      const result = await favoriteCollection.insertOne(newFavorite);
      res.json(result);
    });
    app.get(
      "/favorites/check/:email/:recipeId",
      verifyToken,
      async (req, res) => {
        const { email, recipeId } = req.params;

        if (req.user.email !== email) {
          return res.status(403).json({ message: "Forbidden access" });
        }

        const existing = await favoriteCollection.findOne({
          userEmail: email,
          recipeId,
        });
        res.json({ isFavorite: !!existing });
      },
    );
    app.get("/favorites/:email", verifyToken, async (req, res) => {
      const { email } = req.params;

      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const favorites = await favoriteCollection
        .find({ userEmail: email })
        .toArray();
      const recipeIds = favorites.map((fav) => new ObjectId(fav.recipeId));
      const recipes = await recipeCollection
        .find({ _id: { $in: recipeIds } })
        .toArray();

      res.json(recipes);
    });
    app.delete("/favorites/:recipeId", verifyToken, async (req, res) => {
      const { recipeId } = req.params;
      const email = req.user.email;

      const result = await favoriteCollection.deleteOne({
        userEmail: email,
        recipeId,
      });
      res.json(result);
    });
    app.post("/reports", verifyToken, async (req, res) => {
      const { recipeId, reason } = req.body;
      const reporterEmail = req.user.email;

      const validReasons = ["Spam", "Offensive Content", "Copyright Issue"];
      if (!validReasons.includes(reason)) {
        return res.status(400).json({ message: "Invalid report reason" });
      }

      const newReport = {
        recipeId,
        reporterEmail,
        reason,
        status: "pending",
        createdAt: new Date(),
      };

      const result = await reportCollection.insertOne(newReport);
      res.json(result);
    });
    app.get("/admin/reports", verifyToken, verifyAdmin, async (req, res) => {
      const reports = await reportCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      const recipeIds = reports
        .filter((r) => ObjectId.isValid(r.recipeId))
        .map((r) => new ObjectId(r.recipeId));

      const recipes = await recipeCollection
        .find({ _id: { $in: recipeIds } })
        .toArray();

      const populatedReports = reports.map((report) => {
        const recipe = recipes.find(
          (r) => r._id.toString() === report.recipeId,
        );
        return {
          ...report,
          recipeName: recipe?.recipeName || "Recipe deleted",
        };
      });

      res.json(populatedReports);
    });
    app.patch(
      "/admin/reports/dismiss/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const result = await reportCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "dismissed" } },
        );
        res.json(result);
      },
    );
    app.delete(
      "/admin/reports/remove/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;

        const report = await reportCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!report) {
          return res.status(404).json({ message: "Report not found" });
        }
        if (ObjectId.isValid(report.recipeId)) {
          await recipeCollection.deleteOne({
            _id: new ObjectId(report.recipeId),
          });
        }
        const result = await reportCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "removed" } },
        );

        res.json(result);
      },
    );
    app.post("/payments/save", verifyToken, async (req, res) => {
      const { sessionId, userEmail, type, recipeId } = req.body;

      if (req.user.email !== userEmail) {
        return res.status(403).json({ message: "Forbidden access" });
      }
      const existing = await paymentCollection.findOne({
        transactionId: sessionId,
      });
      if (existing) {
        return res.json({ message: "Already saved", alreadyExists: true });
      }
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== "paid") {
        return res.status(400).json({ message: "Payment not completed" });
      }

      await paymentCollection.insertOne({
        userEmail,
        userId: req.user.id || req.user.sub || "",
        amount: session.amount_total / 100,
        recipeId: recipeId || null,
        transactionId: session.payment_intent,
        paymentStatus: "success",
        type,
        paidAt: new Date(),
      });
      if (type === "premium") {
        await userCollection.updateOne(
          { email: userEmail },
          { $set: { isPremium: true, updatedAt: new Date() } },
        );
      }

      res.json({ success: true });
    });
    app.get("/payments/:email", verifyToken, async (req, res) => {
      const { email } = req.params;

      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const payments = await paymentCollection
        .find({ userEmail: email, paymentStatus: "success" })
        .sort({ paidAt: -1 })
        .toArray();

      const recipeIds = payments
        .filter((p) => p.recipeId && ObjectId.isValid(p.recipeId))
        .map((p) => new ObjectId(p.recipeId));

      const recipes = await recipeCollection
        .find({ _id: { $in: recipeIds } })
        .toArray();

      const result = payments
        .filter((payment) => payment.type === "recipe" && payment.recipeId)
        .map((payment) => {
          const recipe = recipes.find(
            (r) => r._id.toString() === payment.recipeId,
          );
          if (!recipe) return null;
          return {
            ...recipe,
            purchasedAt: payment.paidAt,
            transactionId: payment.transactionId,
            amount: payment.amount,
          };
        })
        .filter(Boolean);

      res.json(result);
    });
    app.post(
      "/create-payment-intent/premium",
      verifyToken,
      async (req, res) => {
        const { email, name } = req.body;

        if (req.user.email !== email) {
          return res.status(403).json({ message: "Forbidden access" });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "RecipeHub Premium Membership",
                  description: "Unlimited recipe uploads + Premium badge",
                },
                unit_amount: 999,
              },
              quantity: 1,
            },
          ],
          metadata: {
            type: "premium",
            userEmail: email,
            userName: name,
          },
          success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/dashboard/profile`,
        });

        res.json({ url: session.url, sessionId: session.id });
      },
    );

    app.post("/create-payment-intent/recipe", verifyToken, async (req, res) => {
      const { email, name, recipeId, recipeName, price } = req.body;

      if (req.user.email !== email) {
        return res.status(403).json({ message: "Forbidden access" });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: recipeName,
                description: "Full recipe access — one-time purchase",
              },
              unit_amount: Math.round(price * 100),
            },
            quantity: 1,
          },
        ],
        metadata: {
          type: "recipe",
          userEmail: email,
          userName: name,
          recipeId: recipeId,
        },
        success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/recipes/${recipeId}`,
      });

      res.json({ url: session.url, sessionId: session.id });
    });

    app.get("/verify-payment/:sessionId", verifyToken, async (req, res) => {
      const { sessionId } = req.params;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid") {
        return res.status(400).json({ message: "Payment not completed" });
      }

      res.json({
        success: true,
        type: session.metadata.type,
        amount: session.amount_total / 100,
        transactionId: session.payment_intent,
        recipeId: session.metadata.recipeId || null,
      });
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
