import { Request, Response } from "express";
import { getStatus } from "../../../scrape/status";

export const getScrapeStatusHandler = (req: Request, res: Response) => {
  try {
    const status = getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};

export default getScrapeStatusHandler;
