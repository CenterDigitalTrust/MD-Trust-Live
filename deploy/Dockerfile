FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY ebs ./ebs
COPY tools ./tools
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "ebs/src/main.ts"]
COPY --chown=node:node panel/dist ./panel/dist
