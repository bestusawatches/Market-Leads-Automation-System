# Real Estate Leads Client

A React + TypeScript + Tailwind CSS frontend for the real estate scraper automation system.

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Start the development server:

```bash
npm run dev
```

The app will open at `http://localhost:3000`

### Build

Build for production:

```bash
npm run build
```

### Preview

Preview the production build:

```bash
npm run preview
```

## Project Structure

```
src/
├── main.tsx          # Application entry point
├── App.tsx           # Root component
├── App.css           # App-specific styles
├── index.css         # Global styles (Tailwind imports)
└── components/       # Reusable components (add as needed)
```

## Environment Variables

Create a `.env` file based on `.env.example`:

```env
VITE_API_URL=http://localhost:5000/api
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

## Tech Stack

- **React 18** - UI library
- **TypeScript** - Type safety
- **Tailwind CSS** - Utility-first CSS
- **Vite** - Fast build tool
- **Vite React Plugin** - React fast refresh

## Next Steps

1. Create reusable components in `src/components/`
2. Set up routing with React Router
3. Add API client for backend communication
4. Implement state management (Redux, Zustand, etc.)
5. Add tests with Vitest/React Testing Library
