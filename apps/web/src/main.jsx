import { createRoot } from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import "./styles.css";
import App from "./App.jsx";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Web Scraper root element is missing.");
createRoot(rootElement).render(<App />);
