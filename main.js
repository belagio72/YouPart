document.addEventListener('DOMContentLoaded', () => {
    let currentQuery = '';
    let currentRegion = 'global'; // Default to global for initial load
    let offset = 0;
    let totalPages = 0;
    let isInitialLoad = true;

    // Search functions
    async function startSearch(region) {
        const input = document.getElementById('searchInput');
        currentQuery = input.value.trim();
        currentRegion = region;
        
        if (!currentQuery) {
            alert('Моля въведете ключова дума за търсене');
            return;
        }

        offset = 0;
        isInitialLoad = false;
        document.getElementById('results').innerHTML = '<p>Търсене...</p>';
        await fetchResults();
    }

    async function fetchResults() {
        try {
            let url;
            const encodedQuery = encodeURIComponent(currentQuery);
            
            // Determine which endpoint to use
            if (currentRegion === 'global' || isInitialLoad) {
                url = `/search-global?part=${encodedQuery}&offset=${offset}`;
                console.log('Using GLOBAL search endpoint');
            } else {
                url = `/search?part=${encodedQuery}&offset=${offset}&region=europe`;
                console.log('Using EUROPE search endpoint');
            }

            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const data = await response.json();
            processResults(data);
        } catch (error) {
            console.error('Search error:', error);
            document.getElementById('results').innerHTML = 
                '<p>⚠️ Възникна грешка при търсенето. Моля, опитайте отново.</p>';
        }
    }

    function processResults(data) {
        if (!data.results || data.results.length === 0) {
            document.getElementById('results').innerHTML = '<p>Няма намерени резултати</p>';
            document.getElementById('pagination').innerHTML = '';
            return;
        }

        // For initial load, show random 12 items without pagination
        if (isInitialLoad) {
            const randomResults = getRandomItems(data.results, 12);
            renderResults(randomResults);
            document.getElementById('pagination').style.display = 'none';
        } 
        // For manual searches, show all results with pagination
        else {
            renderResults(data.results);
            document.getElementById('pagination').style.display = 'block';
            renderPagination(data.total || data.results.length * 3);
        }
    }

    function renderResults(items) {
        const resultsContainer = document.getElementById('results');
        resultsContainer.innerHTML = '';

        items.forEach(item => {
            const itemElement = document.createElement('div');
            itemElement.className = 'item';
            itemElement.innerHTML = `
                <a href="product.html?id=${item.itemId}&title=${encodeURIComponent(item.title)}&priceBGN=${item.priceBGN}">
                    <img src="${item.image}" alt="${item.title}" loading="lazy" />
                    <h3>${item.title}</h3>
                    <p>${item.priceBGN} лв. <span class="euro-price">(${item.priceEUR} €)</span></p>
                </a>
            `;
            resultsContainer.appendChild(itemElement);
        });
    }

    // Utility functions
    function getRandomItems(array, count) {
        const shuffled = [...array].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    function renderPagination(totalItems) {
        const itemsPerPage = 20;
        totalPages = Math.ceil(totalItems / itemsPerPage);
        const currentPage = Math.floor(offset / itemsPerPage) + 1;
        const paginationEl = document.getElementById('pagination');
        paginationEl.innerHTML = '';

        // Helper function to create pagination buttons
        const createButton = (text, targetPage, disabled = false) => {
            const button = document.createElement('button');
            button.textContent = text;
            button.disabled = disabled;
            button.onclick = () => {
                offset = (targetPage - 1) * itemsPerPage;
                fetchResults();
            };
            return button;
        };

        // Add pagination controls
        paginationEl.appendChild(createButton('Първа', 1, currentPage === 1));
        paginationEl.appendChild(createButton('Предишна', currentPage - 1, currentPage === 1));

        // Page numbers
        const startPage = Math.max(1, currentPage - 2);
        const endPage = Math.min(totalPages, startPage + 4);

        for (let i = startPage; i <= endPage; i++) {
            const pageBtn = createButton(i, i);
            if (i === currentPage) {
                pageBtn.classList.add('active');
            }
            paginationEl.appendChild(pageBtn);
        }

        paginationEl.appendChild(createButton('Следваща', currentPage + 1, currentPage === totalPages));
        paginationEl.appendChild(createButton('Последна', totalPages, currentPage === totalPages));

        // Page info
        const pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = `Страница ${currentPage} от ${totalPages}`;
        paginationEl.appendChild(pageInfo);
    }

    // Initialize with random global items
    const sampleWords = ['rims', 'bumper', 'liftgate', 'headlight', 'gearbox', 'alternator'];
    
    function initializeRandomSearch() {
        if (!document.getElementById('searchInput').value.trim()) {
            currentQuery = sampleWords[Math.floor(Math.random() * sampleWords.length)];
            currentRegion = 'global';
            offset = 0;
            isInitialLoad = true;
            fetchResults();
        }
    }

    // Event listeners
    window.addEventListener('DOMContentLoaded', initializeRandomSearch);
    
    // Expose functions to window for button clicks
    window.startSearch = startSearch;
});
