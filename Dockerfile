FROM node:20-alpine

# git needed for github: npm dependency, python3/make/g++ for bcrypt and sqlite3
RUN apk add --no-cache git python3 make g++

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 8000

CMD ["node", "index.js"]
