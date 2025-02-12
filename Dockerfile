FROM node:20-alpine
WORKDIR /app
COPY . .

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1
RUN yarn install --frozen-lockfile

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

USER nextjs

ENV PORT 3000

CMD ["node", "index.js"]

# If using npm comment out above and use below instead
# CMD ["npm", "run", "start"]