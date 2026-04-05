const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const userService = {
  async createUser(email, password, name) {
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
        },
      });

      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      };
    } catch (error) {
      if (error.code === "P2002") {
        return {
          success: false,
          error: "Email already exists",
        };
      }
      throw error;
    }
  },

  async getUserByEmail(email) {
    return prisma.user.findUnique({
      where: { email },
    });
  },

  async validatePassword(email, plainPassword) {
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return { valid: false, user: null };
    }

    const valid = await bcrypt.compare(plainPassword, user.password);

    return {
      valid,
      user: valid
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
          }
        : null,
    };
  },

  async getUserById(id) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });
  },
};

module.exports = {
  userService,
};
