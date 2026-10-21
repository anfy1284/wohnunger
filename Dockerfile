FROM node:20-alpine

# git needed for github: npm dependency, python3/make/g++ for bcrypt and sqlite3
RUN apk add --no-cache git python3 make g++

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY . .

# Коммит приложения. `.git` в образ не попадает (.dockerignore), поэтому версию
# передаёт сборка: docker build --build-arg APP_COMMIT=$(git rev-parse HEAD) .
# Попадает в db_versions при старте — по копии базы видно, какой код её запускал.
ARG APP_COMMIT=""
ENV APP_COMMIT=$APP_COMMIT

EXPOSE 8000

CMD ["node", "index.js"]
