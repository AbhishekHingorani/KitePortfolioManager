const fs = require("fs");
const axios = require("axios");
require("dotenv").config();
const DOMParser = require("xmldom").DOMParser;
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const argv = require("minimist")(process.argv.slice(2));

const authToken = process.env.KITE_TOKEN;

let dir = "";

(async () => {
	try {
		await main();
	} catch (e) {
		console.error(e);
	}
})();

async function main() {
	let portfolioStocks;
	if (argv.m === "portfolio") {
		portfolioStocks = await getStocksInKitePortfolio();
	} else if (argv.m === "all") {
		portfolioStocks = JSON.parse(
			require("fs").readFileSync("list.json", "utf8")
		).map((ticker) => ({ ticker }));
	}

	await getAdditionalDetailsOfStocks(portfolioStocks);
	calculatePercentages(portfolioStocks);
	await writeToCSV(portfolioStocks);
}

async function getStocksInKitePortfolio() {
	const config = {
		headers: {
			Authorization: authToken,
		},
	};
	const output = [];
	let response = await axios.get(
		"https://kite.zerodha.com/oms/portfolio/holdings",
		config
	);
	response.data.data.forEach((element) => {
		// let details = getStockDetails(element.tradingsymbol);
		output.push({
			ticker: element.tradingsymbol,
			qty: element.quantity + element.t1_quantity,
			avgBuyingPrice: element.average_price,
			lastPrice: element.last_price,
		});
	});

	return output;
}

async function getAdditionalDetailsOfStocks(portfolioStocks) {
	const renameStock = getStocksToRename();

	for (const [index, stock] of portfolioStocks.entries()) {
		stock.ticker = renameStock.has(stock.ticker)
			? renameStock.get(stock.ticker)
			: stock.ticker;

		writeToFile(false, index + " | " + stock.ticker + " ! ");

		const html = await getStockHTML(stock.ticker);
		let json = getJSONFromHTML(html, stock.ticker);

		if (
			json &&
			json.data &&
			json.data.overview &&
			json.data.overview.stock &&
			json.data.overview.stock.info
		) {
			const stockInfo = json.data.overview.stock.info;
			stock.name = stockInfo.name;
			stock.description = stockInfo.description;
			stock.sector = stockInfo.sector;
			stock.tickertapeURL =
				"https://stocks.tickertape.in/" + stock.ticker;

			getSmallcaseData(json, stock);
			await getExpertForecast(json, stock);
			writeToFile(false, "processed\n");
		}

		writeToFile(true, stock);
		logCompletionPercent(index, portfolioStocks.length);
	}
}

async function getStockHTML(stockName) {
	try {
		const body = await axios.get(
			"https://stocks.tickertape.in/" + stockName
		);
		const parser = new DOMParser();
		return parser.parseFromString(body.data, "text/xml");
	} catch (err) {
		console.log(stockName + " - API errror");
		writeToFile(false, "Error in API call\n");
	}
}

function getStocksToRename() {
	const renameStock = new Map();
	renameStock.set("FLUOROCHEM-BE", "FLUOROCHEM");
	renameStock.set("AWL-BE", "AWL");
	return renameStock;
}

function getJSONFromHTML(document, stockName) {
	if (!document) {
		writeToFile(false, "Data Not Found\n");
		console.log(stockName + " - Data Not Found");
		return null;
	}

	let pageProps = JSON.parse(
		document.getElementsByTagName("script")[1].childNodes[0].data
	).props.pageProps;

	if (!pageProps.notFound) {
		let val = {};
		val.data = pageProps.overview.data;
		val.tickertapeId = val.data.overview.sid;
		val.smallcases = pageProps.peers.data.smallcases;
		return val;
	} else {
		writeToFile(false, "Data Not Found\n");
		console.log(stockName + " - Data Not Found");
		return null;
	}
}

function getSmallcaseData(json, stock) {
	let smallcases = json && json.smallcases ? json.smallcases : null;
	if (smallcases) {
		if (smallcases.length > 0) {
			let result = [];

			for (const smallcase of smallcases) {
				result.push(smallcase.info.name);
			}
			stock.smallcases = result;
			stock.smallcaseCount = smallcases.length;
		}
	}
}

async function getExpertForecast(json, stock) {
	if (json && json.tickertapeId) {
		const body = await axios.get(
			"https://api.tickertape.in/stocks/summary/" + json.tickertapeId
		);

		if (
			body &&
			body.data &&
			body.data.data &&
			body.data.data.forecast &&
			body.data.data.forecast.percBuyReco
		) {
			stock.percentOfAnalystSuggesting =
				body.data.data.forecast.percBuyReco;
		}
	}
}

function calculatePercentages(stocks) {
	let portfolioBuyPriceSum = 0;
	let portfolioCurrentPriceSum = 0;
	stocks.forEach((obj) => {
		portfolioBuyPriceSum += obj.avgBuyingPrice;
		portfolioCurrentPriceSum += obj.lastPrice;
	});

	stocks.forEach((obj) => {
		obj.avgBuyPriceTotal = obj.avgBuyingPrice * obj.qty;
		obj.currentPriceTotal = obj.lastPrice * obj.qty;
		obj.profitLoss = obj.currentPriceTotal - obj.avgBuyPriceTotal;
		obj.percentProfitLoss =
			((obj.currentPriceTotal - obj.avgBuyPriceTotal) /
				obj.avgBuyPriceTotal) *
			100;
		obj.percentInPortfolio =
			(obj.currentPriceTotal * 100) / portfolioCurrentPriceSum;
	});
}

function getDate() {
	const currentDate = new Date();
	const day = currentDate.getDate();
	const month = currentDate.getMonth() + 1;
	const year = currentDate.getFullYear();
	const hour = currentDate.getHours();
	const min = currentDate.getMinutes();
	const sec = currentDate.getSeconds();

	return day + "-" + month + "-" + year + "/" + hour + "-" + min + "-" + sec;
}

function writeToFile(isResult, content) {
	createOutputDir();
	let fileName = isResult ? dir + "/result.json" : dir + "/log.txt";
	content = isResult ? JSON.stringify(content) + "," : content;
	fs.appendFileSync(fileName, content, function (err) {
		if (err) throw err;
	});
}

function createOutputDir() {
	if (dir === "") {
		dir = "./output/" + getDate();
	}

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

async function writeToCSV(obj) {
	createOutputDir();
	const path = dir + "/portfolio.csv";

	const csvWriter = createCsvWriter({
		path: path,
		header: [
			{ id: "name", title: "Name" },
			{ id: "ticker", title: "Ticker" },
			{ id: "qty", title: "Quantity" },
			{ id: "avgBuyingPrice", title: "Average Buying Price" },
			{ id: "lastPrice", title: "Last Price" },
			{ id: "avgBuyPriceTotal", title: "Total Buy Price" },
			{ id: "currentPriceTotal", title: "Total Current Price" },
			{ id: "profitLoss", title: "P&L" },
			{ id: "percentProfitLoss", title: "P&L Precent" },
			{ id: "percentInPortfolio", title: "Percent Size in Portfolio" },
			{ id: "description", title: "Description" },
			{ id: "sector", title: "Sector" },
			{ id: "smallcases", title: "Smallcases" },
			{ id: "smallcaseCount", title: "smallcaseCount" },
			{
				id: "percentOfAnalystSuggesting",
				title: "Percent of Analyst Suggesting",
			},
			{ id: "tickertapeURL", title: "tickertapeURL" },
		],
	});

	await csvWriter.writeRecords(obj);
	console.log("CSV created at: " + path);
}

function logCompletionPercent(i, total) {
	process.stdout.write(".");
	if ((i + 1) % 10 == 0) {
		console.log(
			"\r\n==== completion " + (i + 1) + " of " + total + " ====\r\n"
		);
	}
}
