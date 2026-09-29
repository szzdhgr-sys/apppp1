FROM node:20-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
VOLUME ["/app/data","/app/media"]
EXPOSE 3000
CMD ["node","server/index.js"]
