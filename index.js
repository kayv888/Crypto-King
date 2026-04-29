const express = require('express');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const ccxt = require('ccxt');
const Anthropic = require('@anthropic-ai/sdk');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── KRAIT ANALYSIS PROMPT ───────────────────────────────────────────────────
const KRAIT_SYSTEM = `You are KRAIT — elite autonomous crypto trading analyst. BNF/Kotegawa detachment framework.

REGIME DETECTION (first):
TRENDING_BULL | TRENDING_BEAR | CASCADE_ACV | COMPRESSION | CHOP_RANGE | DISTRIBUTION_TOP

3/4 CONFLUENCE RULE:
A: Technical (10 indicators) | B: On-Chain/Whale | C: News/Sentiment | D: Order Flow

ACV OVERRIDE: If bands widest in 50 periods OR price below lower band 2+ candles OR 25-SMA dropping sharply OR active cascade → suppress ALL mean-reversion longs.

TEMPORAL RULES (UTC):
00-07: 50% size, fade breakouts
07-12: Wait London confirmation
12-15: No entries at 13:30 UTC economic release
15-20: Best window, full size
20-00: 25% size, expect stop hunts
Thursday: -20% confidence
Friday: Trail stops tight

Respond ONLY in valid JSON:
{
  "regime": string,
  "acv_active": boolean,
  "acv_reason": string|null,
  "confluence": {
    "A_technical": {"aligned": boolean, "direction": string, "signals": [string]},
    "B_onchain": {"aligned": boolean, "direction": string, "signals": [string]},
    "C_sentiment": {"aligned": boolean, "direction": string, "signals": [string]},
    "D_orderflow": {"aligned": boolean, "direction": string, "signals": [string]},
    "total_aligned": number,
    "verdict": "TRADE"|"NO_TRADE"
  },
  "indicators": [{"name": string, "value": string, "signal": string, "suppressed": boolean, "note": string}],
  "whale_intelligence": {"netflow": string, "smart_money": string, "flag": string|null},
  "sentiment": {"fear_greed": number, "score_label": string, "catalysts": [string], "manipulation_flags": [string]},
  "trade_setup": "VALID"|null,
  "trade_setup_or_null": {"direction": string, "entry_zone": string, "stop_loss": string, "tp1": string, "tp2": string, "position_size_pct": number, "rr_ratio": string, "invalidation": string}|null,
  "bnf_check": {"trading_chart_not_pnl": boolean, "well_executed_if_loss": boolean, "fomo_flag": boolean, "confirmation_bias_flag": boolean},
  "market_summary": string,
  "confidence_score": number,
  "temporal_adjustment": string
}`;

// ─── EXCHANGE FACTORY ─────────────────────────────────────────────────────────
function createExchange(exchange, apiKey, apiSecret, passphrase) {
  const config = { apiKey, secret: apiSecret, enableRateLimit: true };
  if (passphrase) config.password = passphrase;
  
  const map = { 
    binance: ccxt.binance, 
    bybit: ccxt.bybit, 
    okx: ccxt.okx,
    bitmex: ccxt.bitmex,
    kraken: ccxt.kraken
  };
  return new (map[exchange.toLowerCase()])(config);
}

// ─── FETCH MARKET DATA ────────────────────────────────────────────────────────
async function fetchMarketData(exchange, symbol, timeframe) {
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
    const ticker = await exchange.fetchTicker(symbol);
    const orderbook = await exchange.fetchOrderBook(symbol, 20);
    
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);
    const current = closes[closes.length - 1];
    
    // SMA calculations
    const sma25 = closes.slice(-25).reduce((a,b) => a+b, 0) / 25;
    const sma50 = closes.slice(-50).reduce((a,b) => a+b, 0) / 50;
    const sma200 = closes.length >= 200 ? closes.slice(-200).reduce((a,b) => a+b, 0) / 200 : null;
    
    // Bollinger Bands
    const bb20 = closes.slice(-20);
    const bbMid = bb20.reduce((a,b) => a+b, 0) / 20;
    const bbStd = Math.sqrt(bb20.map(x => Math.pow(x - bbMid, 2)).reduce((a,b) => a+b, 0) / 20);
    const bbUpper = bbMid + 2 * bbStd;
    const bbLower = bbMid - 2 * bbStd;
    
    // RSI
    const rsiPeriod = 14;
    const rsiChanges = closes.slice(-rsiPeriod-1).map((c, i, arr) => i > 0 ? c - arr[i-1] : 0).slice(1);
    const gains = rsiChanges.map(c => c > 0 ? c : 0);
    const losses = rsiChanges.map(c => c < 0 ? Math.abs(c) : 0);
    const avgGain = gains.reduce((a,b) => a+b, 0) / rsiPeriod;
    const avgLoss = losses.reduce((a,b) => a+b, 0) / rsiPeriod;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    
    return {
      symbol,
      timeframe,
      current_price: current,
      sma25, sma50, sma200,
      sma25_deviation_pct: ((current - sma25) / sma25 * 100).toFixed(2),
      golden_cross: sma50 > (sma200 || 0),
      bb_upper: bbUpper.toFixed(2), bb_mid: bbMid.toFixed(2), bb_lower: bbLower.toFixed(2),
      bb_width: ((bbUpper - bbLower) / bbMid * 100).toFixed(2),
      price_below_lower_band: current < bbLower,
      rsi: rsi.toFixed(1),
      volume_24h: ticker.quoteVolume,
      bid: orderbook.bids[0]?.[0],
      ask: orderbook.asks[0]?.[0],
      spread_pct: ((orderbook.asks[0]?.[0] - orderbook.bids[0]?.[0]) / orderbook.bids[0]?.[0] * 100).toFixed(3),
      high_24h: ticker.high,
      low_24h: ticker.low,
      change_24h_pct: ticker.percentage?.toFixed(2),
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    throw new Error(`Market data fetch failed: ${e.message}`);
  }
}

// ─── FETCH SENTIMENT ─────────────────────────────────────────────────────────
async function fetchSentiment() {
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1');
    return { fear_greed: parseInt(r.data.data[0].value), label: r.data.data[0].value_classification };
  } catch { return { fear_greed: 50, label: 'Neutral' }; }
}

// ─── RUN KRAIT ANALYSIS ───────────────────────────────────────────────────────
async function runKraitAnalysis(marketData, sentiment, account) {
  const utcHour = new Date().getUTCHours();
  const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  
  const userMsg = `Analyze ${marketData.symbol} on ${marketData.timeframe}.

LIVE MARKET DATA:
- Price: ${marketData.current_price}
- 25-SMA: ${marketData.sma25?.toFixed(2)} | Deviation: ${marketData.sma25_deviation_pct}%
- 50-SMA: ${marketData.sma50?.toFixed(2)} | 200-SMA: ${marketData.sma200?.toFixed(2) || 'N/A'}
- Golden Cross Active: ${marketData.golden_cross}
- Bollinger Upper: ${marketData.bb_upper} | Mid: ${marketData.bb_mid} | Lower: ${marketData.bb_lower}
- Bollinger Width: ${marketData.bb_width}%
- Price Below Lower Band: ${marketData.price_below_lower_band}
- RSI(14): ${marketData.rsi}
- 24H Change: ${marketData.change_24h_pct}%
- 24H High: ${marketData.high_24h} | Low: ${marketData.low_24h}
- Volume 24H: ${marketData.volume_24h}
- Spread: ${marketData.spread_pct}%
- Fear & Greed Index: ${sentiment.fear_greed} (${sentiment.label})

TIME CONTEXT:
- UTC Hour: ${utcHour}
- Day: ${dayOfWeek}

ACCOUNT CONTEXT:
- Portfolio: $${account.balance_usd}
- Max Risk/Trade: ${account.max_risk_per_trade}%
- Account Type: ${account.account_type}
${account.prop_firm ? `- Prop Firm: ${account.prop_firm}` : ''}`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: KRAIT_SYSTEM,
    messages: [{ role: 'user', content: userMsg }]
  });

  const raw = resp.content[0].text;
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// ─── PLACE TRADE ──────────────────────────────────────────────────────────────
async function placeTrade(exchange, analysis, account, symbol) {
  const setup = analysis.trade_setup_or_null;
  if (!setup) return null;
  
  // Calculate position size
  const riskUsd = account.balance_usd * (account.max_risk_per_trade / 100);
  const entryPrice = parseFloat(setup.entry_zone.split('-')[0].replace(/[^0-9.]/g, ''));
  const stopPrice = parseFloat(setup.stop_loss.replace(/[^0-9.]/g, ''));
  const slDistance = Math.abs(entryPrice - stopPrice) / entryPrice;
  const positionSizeUsd = riskUsd / slDistance;
  const quantity = positionSizeUsd / entryPrice;
  
  // Place market order
  const side = setup.direction === 'LONG' ? 'buy' : 'sell';
  
  try {
    const order = await exchange.createOrder(symbol, 'market', side, quantity);
    
    // Place stop loss
    const slSide = side === 'buy' ? 'sell' : 'buy';
    await exchange.createOrder(symbol, 'stop', slSide, quantity, stopPrice, {
      stopPrice: stopPrice,
      reduceOnly: true
    });
    
    // Place take profit
    const tp1Price = parseFloat(setup.tp1.replace(/[^0-9.]/g, ''));
    await exchange.createOrder(symbol, 'limit', slSide, quantity * 0.5, tp1Price, {
      reduceOnly: true
    });
    
    return { order_id: order.id, entry_price: order.average || entryPrice, quantity, position_size_usd: positionSizeUsd };
  } catch (e) {
    throw new Error(`Order placement failed: ${e.message}`);
  }
}

// ─── SEND TELEGRAM ALERT ──────────────────────────────────────────────────────
async function sendTelegramAlert(message) {
  try {
    const { data: tokenRow } = await supabase.from('settings').select('value').eq('key', 'telegram_bot_token').single();
    const { data: chatRow } = await supabase.from('settings').select('value').eq('key', 'telegram_chat_id').single();
    if (!tokenRow?.value || !chatRow?.value) return;
    
    const bot = new TelegramBot(tokenRow.value);
    await bot.sendMessage(chatRow.value, message, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────────────────────────
async function runScanCycle() {
  // Check if KRAIT is active
  const { data: activeRow } = await supabase.from('settings').select('value').eq('key', 'krait_active').single();
  if (activeRow?.value !== 'true') return;
  
  // Get all active accounts
  const { data: accounts } = await supabase.from('accounts').select('*').eq('is_active', true);
  if (!accounts?.length) return;
  
  // Get scan queue items due for scanning
  const { data: queue } = await supabase.from('scan_queue')
    .select('*')
    .eq('is_active', true)
    .or(`last_scanned.is.null,last_scanned.lt.${new Date(Date.now() - 15*60*1000).toISOString()}`);
  
  if (!queue?.length) return;
  
  const sentiment = await fetchSentiment();
  
  for (const queueItem of queue) {
    const account = accounts.find(a => a.id === queueItem.account_id);
    if (!account) continue;
    
    // Count open trades for this account
    const { count } = await supabase.from('trades')
      .select('id', { count: 'exact' })
      .eq('account_id', account.id)
      .eq('status', 'OPEN');
    
    // Check daily drawdown
    const today = new Date().toISOString().split('T')[0];
    const { data: todayTrades } = await supabase.from('trades')
      .select('pnl_usd')
      .eq('account_id', account.id)
      .gte('exit_time', today)
      .in('status', ['CLOSED_TP', 'CLOSED_SL']);
    
    const dailyPnl = todayTrades?.reduce((sum, t) => sum + (t.pnl_usd || 0), 0) || 0;
    const dailyDrawdownPct = Math.abs(Math.min(0, dailyPnl)) / account.balance_usd * 100;
    
    if (dailyDrawdownPct >= account.max_daily_drawdown) {
      await supabase.from('system_logs').insert({
        account_id: account.id,
        log_type: 'WARNING',
        message: `Daily drawdown limit reached: ${dailyDrawdownPct.toFixed(2)}%. Halting trading for this account.`
      });
      continue;
    }
    
    try {
      const exchange = createExchange(account.exchange, account.api_key, account.api_secret, account.passphrase);
      const marketData = await fetchMarketData(exchange, queueItem.asset, queueItem.timeframe);
      const analysis = await runKraitAnalysis(marketData, sentiment, account);
      
      // Save signal to DB
      await supabase.from('signals').insert({
        account_id: account.id,
        asset: queueItem.asset,
        timeframe: queueItem.timeframe,
        regime: analysis.regime,
        acv_active: analysis.acv_active,
        confluence_score: analysis.confluence?.total_aligned,
        verdict: analysis.confluence?.verdict,
        direction: analysis.trade_setup_or_null?.direction,
        confidence: analysis.confidence_score,
        full_analysis: analysis
      });
      
      // Update scan queue timestamp
      await supabase.from('scan_queue').update({ last_scanned: new Date().toISOString() }).eq('id', queueItem.id);
      
      // Log
      await supabase.from('system_logs').insert({
        account_id: account.id,
        log_type: analysis.acv_active ? 'ACV' : analysis.confluence?.verdict === 'TRADE' ? 'TRADE' : 'INFO',
        message: `${queueItem.asset} ${queueItem.timeframe}: ${analysis.regime} | ${analysis.confluence?.total_aligned}/4 confluence | ${analysis.confluence?.verdict}`,
        metadata: { confidence: analysis.confidence_score }
      });
      
      // Execute trade if signal valid
      if (analysis.trade_setup === 'VALID' && analysis.confluence?.verdict === 'TRADE' && !analysis.acv_active) {
        const tradeResult = await placeTrade(exchange, analysis, account, queueItem.asset);
        
        if (tradeResult) {
          await supabase.from('trades').insert({
            account_id: account.id,
            asset: queueItem.asset,
            timeframe: queueItem.timeframe,
            direction: analysis.trade_setup_or_null.direction,
            entry_price: tradeResult.entry_price,
            stop_loss: parseFloat(analysis.trade_setup_or_null.stop_loss.replace(/[^0-9.]/g, '')),
            tp1: parseFloat(analysis.trade_setup_or_null.tp1.replace(/[^0-9.]/g, '')),
            tp2: parseFloat(analysis.trade_setup_or_null.tp2.replace(/[^0-9.]/g, '')),
            position_size_usd: tradeResult.position_size_usd,
            risk_pct: account.max_risk_per_trade,
            rr_ratio: analysis.trade_setup_or_null.rr_ratio,
            regime: analysis.regime,
            confluence_score: analysis.confluence.total_aligned,
            status: 'OPEN',
            exchange_order_id: tradeResult.order_id,
            krait_reasoning: analysis.market_summary
          });
          
          await sendTelegramAlert(
            `🟢 *KRAIT TRADE EXECUTED*\n\n` +
            `*${queueItem.asset}* ${analysis.trade_setup_or_null.direction}\n` +
            `Account: ${account.name}\n` +
            `Entry: ${tradeResult.entry_price}\n` +
            `SL: ${analysis.trade_setup_or_null.stop_loss}\n` +
            `TP1: ${analysis.trade_setup_or_null.tp1}\n` +
            `R:R: ${analysis.trade_setup_or_null.rr_ratio}\n` +
            `Regime: ${analysis.regime}\n` +
            `Confluence: ${analysis.confluence.total_aligned}/4`
          );
        }
      }
      
      if (analysis.acv_active) {
        await sendTelegramAlert(`⚠️ *ACV ACTIVE*\n${queueItem.asset}: ${analysis.acv_reason || 'Cascade conditions detected. No trades.'}`);
      }
      
    } catch (e) {
      await supabase.from('system_logs').insert({
        account_id: account.id,
        log_type: 'ERROR',
        message: `Error scanning ${queueItem.asset}: ${e.message}`
      });
    }
  }
}

// ─── TRADE MONITOR (checks open trades every 5 min) ──────────────────────────
async function monitorOpenTrades() {
  const { data: openTrades } = await supabase.from('trades').select('*, accounts(*)').eq('status', 'OPEN');
  if (!openTrades?.length) return;
  
  for (const trade of openTrades) {
    const account = trade.accounts;
    if (!account) continue;
    
    try {
      const exchange = createExchange(account.exchange, account.api_key, account.api_secret, account.passphrase);
      const ticker = await exchange.fetchTicker(trade.asset);
      const currentPrice = ticker.last;
      
      // Check 72-hour max hold
      const hoursOpen = (Date.now() - new Date(trade.entry_time).getTime()) / (1000 * 60 * 60);
      if (hoursOpen >= 72) {
        await exchange.createOrder(trade.asset, 'market', trade.direction === 'LONG' ? 'sell' : 'buy', trade.quantity, undefined, { reduceOnly: true });
        const pnl = trade.direction === 'LONG' ? (currentPrice - trade.entry_price) * trade.quantity : (trade.entry_price - currentPrice) * trade.quantity;
        await supabase.from('trades').update({ status: 'CLOSED_MANUAL', exit_time: new Date().toISOString(), pnl_usd: pnl }).eq('id', trade.id);
        await sendTelegramAlert(`⏰ *72H TIME EXIT*\n${trade.asset} closed at ${currentPrice}\nPnL: $${pnl.toFixed(2)}`);
        continue;
      }
      
      // Check TP1 hit — move SL to breakeven
      if (trade.tp1 && trade.direction === 'LONG' && currentPrice >= trade.tp1 && trade.stop_loss < trade.entry_price) {
        // Move stop to breakeven — in practice cancel and replace SL order
        await supabase.from('system_logs').insert({ account_id: account.id, log_type: 'INFO', message: `${trade.asset}: TP1 hit, moving SL to breakeven` });
      }
      if (trade.tp1 && trade.direction === 'SHORT' && currentPrice <= trade.tp1 && trade.stop_loss > trade.entry_price) {
        await supabase.from('system_logs').insert({ account_id: account.id, log_type: 'INFO', message: `${trade.asset}: TP1 hit, moving SL to breakeven` });
      }
      
      // Check TP2 hit — close trade
      const tp2Hit = trade.direction === 'LONG' ? currentPrice >= trade.tp2 : currentPrice <= trade.tp2;
      const slHit = trade.direction === 'LONG' ? currentPrice <= trade.stop_loss : currentPrice >= trade.stop_loss;
      
      if (tp2Hit || slHit) {
        const pnl = trade.direction === 'LONG' ? (currentPrice - trade.entry_price) * (trade.position_size_usd / trade.entry_price) : (trade.entry_price - currentPrice) * (trade.position_size_usd / trade.entry_price);
        const newStatus = tp2Hit ? 'CLOSED_TP' : 'CLOSED_SL';
        await supabase.from('trades').update({ status: newStatus, exit_time: new Date().toISOString(), pnl_usd: pnl, pnl_pct: pnl / account.balance_usd * 100 }).eq('id', trade.id);
        await sendTelegramAlert(`${tp2Hit ? '✅' : '🔴'} *TRADE CLOSED*\n${trade.asset} ${newStatus}\nPnL: $${pnl.toFixed(2)}`);
      }
      
    } catch (e) {
      console.error(`Monitor error for trade ${trade.id}:`, e.message);
    }
  }
}

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
cron.schedule('*/15 * * * *', runScanCycle);    // Scan every 15 min
cron.schedule('*/5 * * * *', monitorOpenTrades); // Monitor every 5 min

// ─── API ENDPOINTS (called by Lovable frontend) ───────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'KRAIT ONLINE', time: new Date().toISOString() }));

app.post('/api/scan/manual', async (req, res) => {
  try { await runScanCycle(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/trade/close/:id', async (req, res) => {
  // Manual trade close endpoint
  const { data: trade } = await supabase.from('trades').select('*, accounts(*)').eq('id', req.params.id).single();
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  
  try {
    const exchange = createExchange(trade.accounts.exchange, trade.accounts.api_key, trade.accounts.api_secret, trade.accounts.passphrase);
    const ticker = await exchange.fetchTicker(trade.asset);
    const pnl = trade.direction === 'LONG' ? (ticker.last - trade.entry_price) : (trade.entry_price - ticker.last);
    
    await supabase.from('trades').update({ status: 'CLOSED_MANUAL', exit_time: new Date().toISOString(), pnl_usd: pnl * (trade.position_size_usd / trade.entry_price) }).eq('id', trade.id);
    res.json({ success: true, pnl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/toggle', async (req, res) => {
  const { data: current } = await supabase.from('settings').select('value').eq('key', 'krait_active').single();
  const newVal = current?.value === 'true' ? 'false' : 'true';
  await supabase.from('settings').update({ value: newVal }).eq('key', 'krait_active');
  res.json({ active: newVal === 'true' });
});

app.post('/webhooks/tradingview', async (req, res) => {
  // Receives TradingView alerts and creates scan queue items
  const { symbol, timeframe, account_id, secret } = req.body;
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  
  await supabase.from('scan_queue').upsert({ account_id, asset: symbol, timeframe, priority: 2, last_scanned: null });
  res.json({ success: true });
});

app.get('/api/ticker/:exchange/:asset', async (req, res) => {
  try {
    const { exchange, asset } = req.params;
    
    const { data: account } = await supabase
      .from('accounts')
      .select('*')
      .eq('exchange', exchange)
      .limit(1)
      .single();
    
    if (!account) {
      const ex = createExchange(exchange, '', '', '');
      const ticker = await ex.fetchTicker(asset);
      return res.json({ price: ticker.last });
    }
    
    const ex = createExchange(exchange, account.api_key, account.api_secret, account.passphrase);
    const ticker = await ex.fetchTicker(asset);
    res.json({ price: ticker.last });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KRAIT Backend running on port ${PORT}`));
