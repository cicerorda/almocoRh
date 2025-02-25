const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const imaps = require('imap-simple');
const session = require('express-session'); // Corrigido: importa o `express-session`
const multer = require('multer');
const { simpleParser } = require('mailparser');
const path = require('path');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
require('dotenv').config();

const timestamp = Date.now();
const url = `/api/cardapio/imagem?timestamp=${timestamp}`;

const app = express();
const port = process.env.PORT || 8080;

const csvFilePath = 'pedidos.csv';
const csvFilePathMensal = 'pedidos_mensal.csv';
const lastEmailTimestampFile = 'last_email_timestamp.txt';

app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());

app.get('/favicon.ico', (req, res) => res.status(204));

// Configuração da conexão com o banco de dados
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Função para inicializar a tabela (executar uma vez)
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pedidos (
                id SERIAL PRIMARY KEY,
                nome TEXT,
                empresa TEXT,
                almoco TEXT,
                salada TEXT,
                sobremesa TEXT,
                porcao TEXT,
                carneExtra TEXT,
                observacoes TEXT,
                data_hora TIMESTAMP
            );
        `);
        console.log('Tabela "pedidos" criada ou já existente.');
    } catch (err) {
        console.error('Erro ao inicializar o banco de dados:', err);
    }
}

initializeDatabase();

// Configuração de sessão para autenticação
app.use(session({
    secret: process.env.SESSION_SECRET || 'chave-secreta',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // Use `secure: true` em produção com HTTPS
}));

// Middleware para autenticação
function isAuthenticated(req, res, next) {
    if (req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}

// Rota de login (visualizar o formulário de login)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rota para autenticar login
app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
    const { username, password } = req.body;
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (username === adminUsername && password === adminPassword) {
        req.session.authenticated = true;
        res.redirect('/admin/upload');
    } else {
        res.status(401).send('Usuário ou senha incorretos.');
    }
});

// Rota de logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Rota de upload para substituir as imagens dos dias da semana
app.get('/admin/upload', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Configuração do `multer` para salvar na pasta `public/images`
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public/images'));
    },
    filename: (req, file, cb) => {
        const filePath = path.join(__dirname, 'public/images', file.originalname);
        
        // Se o arquivo já existir, removê-lo
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);  // Apagar o arquivo existente
        }
        
        cb(null, file.originalname);  // Manter o mesmo nome do arquivo
    }
});

const upload = multer({ storage: storage });

// Configuração da pasta `public` para arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota para o upload dos arquivos
app.post('/admin/upload', upload.single('segunda'), (req, res) => {
    if (req.file) {
        console.log('Arquivo recebido:', req.file);
        res.status(200).send('Upload realizado com sucesso!');
    } else {
        res.status(400).send('Erro no upload do arquivo.');
    }
});

// Servir o cardápio para verificação
app.get('/cardapio.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cardapio.html'));
});

// Configurações iniciais
app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'chave-secreta',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true }  // `secure: true` em produção com HTTPS
}));

// Função para salvar cabeçalhos em arquivos CSV
function checkAndWriteHeader(filePath) {
    if (!fs.existsSync(filePath)) {
        const header = 'nome;empresa;almoco;salada;sobremesa;porcao;carneExtra;observacoes;data_hora\n';
        fs.writeFileSync(filePath, header);
    }
}

checkAndWriteHeader(csvFilePath);
checkAndWriteHeader(csvFilePathMensal);

function getLastEmailTimestamp() {
    if (fs.existsSync(lastEmailTimestampFile)) {
        const timestamp = fs.readFileSync(lastEmailTimestampFile, 'utf8');
        return new Date(timestamp);
    }
    return new Date(0);
}

function updateLastEmailTimestamp() {
    const currentTimestamp = new Date().toISOString();
    fs.writeFileSync(lastEmailTimestampFile, currentTimestamp);
}

async function getRecentOrders() {
    try {
        // Obter a data e horário atual
        const now = new Date();

        // Calcular a data inicial
        let startDate;
        if (now.getDay() === 1) { // Segunda-feira (0 = Domingo, 1 = Segunda, ..., 6 = Sábado)
            // Se for segunda-feira, pegar sexta-feira às 10h
            const friday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 10, 0, 0); // Sexta-feira
            startDate = friday;
        } else {
            // Para outros dias, pegar o dia anterior às 10h
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 0, 0); // 10h de ontem
        }

        // Ajustar o horário para UTC (caso necessário)
        const brazilTimeOffset = -3; // UTC-3 para horário de Brasília
        startDate.setHours(startDate.getHours() - brazilTimeOffset);

        // Consultar pedidos feitos desde a data inicial calculada
        const result = await pool.query(
            `SELECT * FROM pedidos WHERE data_hora >= $1 ORDER BY data_hora ASC`,
            [startDate]
        );

        // Formatar os pedidos em formato CSV
        return result.rows.map(row =>
            `${row.nome};${row.empresa};${row.almoco};${row.salada};${row.sobremesa};${row.porcao};${row.carneextra || ''};${row.observacoes || ''};${row.data_hora.toISOString()}`
        ).join('\n');
    } catch (err) {
        console.error('Erro ao buscar pedidos recentes:', err);
        return '';
    }
}

async function generateSummaryCSV(startDate, endDate) {
    try {
        // Consulta SQL ajustada para considerar o intervalo de datas
        const result = await pool.query(
            `
            SELECT 
                nome, 
                COUNT(*) AS pedidos_count, 
                COALESCE(SUM(CASE 
                    WHEN carneExtra ~ '^[0-9]+$' THEN CAST(carneExtra AS INTEGER) 
                    ELSE 0 END), 0) AS carneextra_total
            FROM pedidos
            WHERE data_hora BETWEEN $1 AND $2
            GROUP BY nome
            ORDER BY pedidos_count DESC;
            `,
            [startDate, endDate]
        );

        // Formata os resultados em formato CSV
        const csvHeader = 'nome;quantidade_pedidos;carneextra_total\n';
        const csvContent = result.rows
            .map(row => `${row.nome};${row.pedidos_count};${row.carneextra_total}`)
            .join('\n');

        const finalCSV = csvHeader + csvContent;

        // Salva o CSV no sistema de arquivos
        const filePath = 'summary_pedidos.csv';
        fs.writeFileSync(filePath, finalCSV);

        console.log(`Resumo gerado com sucesso: ${filePath}`);
        return filePath;
    } catch (err) {
        console.error('Erro ao gerar resumo de pedidos:', err);
        throw err;
    }
}

function generateSummaryFromMensais(rows) {
    // Agrupamento dos dados
    const summary = rows.reduce((acc, row) => {
        if (!acc[row.nome]) {
            acc[row.nome] = { pedidos_count: 0, carneextra_total: 0 };
        }

        acc[row.nome].pedidos_count += 1;

        // Soma a quantidade de carne extra (se for um número válido)
        if (row.carneextra && !isNaN(row.carneextra)) {
            acc[row.nome].carneextra_total += parseInt(row.carneextra, 10);
        }

        return acc;
    }, {});

    // Converter o resumo em formato CSV
    const csvHeader = 'nome;quantidade_pedidos;carneextra_total\n';
    const csvContent = Object.entries(summary)
        .map(([nome, data]) => `${nome};${data.pedidos_count};${data.carneextra_total}`)
        .join('\n');

    return csvHeader + csvContent;
}

app.post('/api/pedidos/enviar-email', async (req, res) => {
    try {
        console.log("Solicitação recebida para enviar e-mail.");
        await enviarEmailDiario(); // Função que processa e envia o e-mail
        res.json({ message: 'E-mail enviado com sucesso!' });
    } catch (error) {
        console.error("Erro ao enviar e-mail:", error);
        res.status(500).json({ message: 'Erro ao enviar e-mail.' });
    }
});

app.post('/api/pedidos/enviar-email-mensal', async (req, res) => {
    try {
        console.log("Solicitação recebida para enviar e-mail.");
        await enviarEmailMensal(); // Função que processa e envia o e-mail
        res.json({ message: 'E-mail enviado com sucesso!' });
    } catch (error) {
        console.error("Erro ao enviar e-mail:", error);
        res.status(500).json({ message: 'Erro ao enviar e-mail.' });
    }
});

// Função para enviar e-mail diario
async function enviarEmailDiario() {
    try {
        const recentOrdersCSV = await getRecentOrders();

        if (!recentOrdersCSV) {
            console.log('Nenhum pedido recente para enviar.');
            return;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"No Reply" <${process.env.GMAIL_USER}>`,
            to: 'recursoshumanos@metalburgo.com.br',
            bcc: 'ttcicero@gmail.com',
            subject: 'Relatório Diário de Pedidos de Refeição',
            text: 'Segue em anexo o relatório de pedidos de refeições recentes.',
            attachments: [
                {
                    filename: 'pedidos_diarios.csv',
                    content: `nome;empresa;almoco;salada;sobremesa;porcao;carneExtra;observacoes;data_hora\n${recentOrdersCSV}`,
                    type: 'text/csv'
                }
            ]
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('E-mail enviado com sucesso:', info.response);
        updateLastEmailTimestamp();
    } catch (error) {
        console.error('Erro ao enviar e-mail diário:', error);
    }
}

async function enviarEmailMensal() {
    try {
        const today = new Date();
        const startDate = new Date(today.getFullYear(), today.getMonth() - 1, 26, 0, 0, 0); // Dia 26 do mês anterior
        const endDate = new Date(today.getFullYear(), today.getMonth(), 25, 23, 59, 59);   // Dia 25 do mês atual

        console.log(`Filtrando pedidos entre ${startDate.toISOString()} e ${endDate.toISOString()}`);

        // Consulta para pedidos mensais
        const result = await pool.query(
            `SELECT * FROM pedidos WHERE data_hora BETWEEN $1 AND $2 ORDER BY data_hora ASC`,
            [startDate, endDate]
        );

        if (result.rows.length === 0) {
            console.log('Nenhum pedido encontrado para o período.');
            return;
        }

        // Formata os pedidos mensais para CSV
        const pedidosMensal = result.rows.map(row =>
            `${row.nome};${row.empresa || ''};${row.almoco};${row.salada};${row.sobremesa};${row.porcao};${row.carneextra || ''};${row.observacoes || ''};${row.data_hora.toISOString()}`
        ).join('\n');

        // Salvar pedidos_mensais.csv
        const filePathMensal = 'pedidos_mensais.csv';
        fs.writeFileSync(filePathMensal, `nome;empresa;almoco;salada;sobremesa;porcao;carneExtra;observacoes;data_hora\n${pedidosMensal}`);

        console.log('Relatório mensal gerado com sucesso.');

        // Gerar o resumo com base nos dados já filtrados
        const summaryData = generateSummaryFromMensais(result.rows);

        const filePathResumo = 'summary_pedidos.csv';
        fs.writeFileSync(filePathResumo, summaryData);

        console.log('Resumo gerado com sucesso.');

        // Configurar transporte de e-mail
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        // Configurar e enviar e-mail
        const mailOptions = {
            from: `"No Reply" <${process.env.GMAIL_USER}>`,
            to: 'recursoshumanos@metalburgo.com.br',
            bcc: 'ttcicero@gmail.com',
            subject: 'Relatório Mensal de Pedidos de Refeição',
            text: `Segue em anexo o relatório de pedidos de refeições entre ${startDate.toISOString()} e ${endDate.toISOString()}.`,
            attachments: [
                {
                    filename: 'pedidos_mensais.csv',
                    path: filePathMensal,
                    type: 'text/csv'
                },
                {
                    filename: 'summary_pedidos.csv',
                    path: filePathResumo,
                    type: 'text/csv'
                }
            ]
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('E-mail mensal enviado com sucesso:', info.response);
    } catch (err) {
        console.error('Erro ao enviar o e-mail mensal:', err);
    }
}

// Função para limpar o conteúdo de um arquivo CSV
function clearCSV(filePath) {
    const header = 'nome;empresa;almoco;salada;sobremesa;porcao;carneExtra;observacoes;data_hora\n';
    fs.writeFileSync(filePath, header);
}

app.post('/api/pedidos/salvar', async (req, res) => {
    const { nome, empresa, almoco, salada, sobremesa, porcao, carneExtra, observacoes } = req.body;
    const dataHora = new Date();

    try {
        await pool.query(
            `INSERT INTO pedidos (nome, empresa, almoco, salada, sobremesa, porcao, carneExtra, observacoes, data_hora)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [nome, empresa, almoco, salada, sobremesa, porcao, carneExtra, observacoes, dataHora]
        );
        res.json({ message: 'Pedido salvo com sucesso!' });
    } catch (err) {
        console.error('Erro ao salvar pedido:', err);
        res.status(500).json({ message: 'Erro ao salvar o pedido.' });
    }
});

app.get('/api/pedidos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pedidos ORDER BY data_hora DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar pedidos:', err);
        res.status(500).json({ message: 'Erro ao buscar os pedidos.' });
    }
});

// Agendamento diário e mensal
cron.schedule('35 9 * * 1-5', enviarEmailDiario, {
    timezone: "America/Sao_Paulo"
});

cron.schedule('0 1 26 * *', () => {
    console.log('Iniciando envio do relatório mensal...');
    enviarEmailMensal();
}, {
    timezone: "America/Sao_Paulo" // Configuração do fuso horário
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});
function getCardapioImagePath() {
    const now = new Date();
    const currentDay = now.getDay(); // 0 = Domingo, 1 = Segunda, ..., 5 = Sexta, 6 = Sábado
    const currentHour = now.getHours();
    let fileName;

    // Sábado e domingo sempre mostram o cardápio de segunda-feira
    if (currentDay === 0 || currentDay === 6) {
        fileName = 'segunda.jpeg';
    } 
    // Segunda a sexta, mas antes das 10h, mostra o cardápio do dia anterior
    else if (currentHour < 13) {
        if (currentDay === 1) {
            fileName = 'segunda.jpeg';
        } else {
            fileName = `${['segunda', 'terca', 'quarta', 'quinta', 'sexta'][currentDay - 1]}.jpeg`;
        }
    } 
    // Segunda a sexta, após 10h, mostra o cardápio do próprio dia
    else {
        fileName = `${['segunda', 'terca', 'quarta', 'quinta', 'sexta'][currentDay]}.jpeg`;
    }

    return path.join(__dirname, 'public', 'images', fileName);
}

// Rota para servir a imagem do cardápio
app.get('/api/cardapio/imagem', (req, res) => {
    const imagePath = getCardapioImagePath();
    
    // Define cabeçalho para desativar cache
    res.set('Cache-Control', 'no-store'); 

    res.sendFile(imagePath, (err) => {
        if (err) {
            console.error('Erro ao enviar a imagem do cardápio:', err);
            res.status(500).send('Erro ao carregar a imagem do cardápio.');
        }
    });
});

// Configuração de sessão
app.use(session({
    secret: process.env.SESSION_SECRET || 'chave-secreta',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // `secure: true` em produção com HTTPS
}));

// Middleware para verificar se o usuário está autenticado
function isAuthenticated(req, res, next) {
    if (req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}


// Rota de upload protegida
app.get('/admin/upload', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/upload', isAuthenticated, upload.fields([
    { name: 'segunda', maxCount: 1 },
    { name: 'terca', maxCount: 1 },
    { name: 'quarta', maxCount: 1 },
    { name: 'quinta', maxCount: 1 },
    { name: 'sexta', maxCount: 1 }
]), (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).send('Nenhum arquivo foi enviado.');
    }
    res.send('Imagens carregadas com sucesso!');
});
// Servir arquivos estáticos da pasta public
app.use(express.static('public'));

// Rota para a página de login
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rota de autenticação para login
app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
    const { username, password } = req.body;

    // Verificar credenciais (defina essas variáveis de ambiente para produção)
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (username === adminUsername && password === adminPassword) {
        req.session.authenticated = true;
        res.redirect('/admin/upload');
    } else {
        res.send('Usuário ou senha incorretos.');
    }
});

// Rota para logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Rota de upload protegida
app.get('/admin/upload', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});


// Rota para processar o upload das imagens, protegida
app.post('/admin/upload', isAuthenticated, upload.fields([
    { name: 'segunda', maxCount: 1 },
    { name: 'terca', maxCount: 1 },
    { name: 'quarta', maxCount: 1 },
    { name: 'quinta', maxCount: 1 },
    { name: 'sexta', maxCount: 1 }
]), (req, res) => {
    res.send('Imagens carregadas com sucesso!');
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});

// Rota para download do arquivo pedidos.csv
app.get('/api/pedidos/download', isAuthenticated, (req, res) => {
    const filePath = path.join(__dirname, csvFilePath);

    // Verifica se o arquivo existe antes de enviá-lo
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'pedidos.csv', (err) => {
            if (err) {
                console.error('Erro ao enviar o arquivo:', err);
                res.status(500).send('Erro ao baixar o arquivo.');
            }
        });
        res.download(filePath, 'pedidos_mensal.csv', (err) => {
            if (err) {
                console.error('Erro ao enviar o arquivo:', err);
                res.status(500).send('Erro ao baixar o arquivo.');
            }
        });
    } else {
        res.status(404).send('Arquivo não encontrado.');
    }
});

module.exports = { enviarEmailDiario };
